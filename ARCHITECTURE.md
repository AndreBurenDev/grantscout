# GrantScout Architecture

> **Outdated: describes the retired Google Cloud deployment.** GrantScout now runs on the Mac Mini with SQLite and
> Ollama. See [infra/mini/README.md](infra/mini/README.md); the old setup is archived in [infra/legacy-gcp](infra/legacy-gcp/README.md).

## System Design

GrantScout is a **demand-side intelligence system** for GrantMaster. It ingests organizations that seek grants, scores them on Fit × Intent × Timing × Reachability, and surfaces top prospects to the sales team.

### Thesis

GrantAtlas already maps every grant and funder (supply side). GrantScout mirrors this: every organization that seeks grants (demand side). By scoring on fit to GrantMaster's capabilities and recent grant activity, we convert discovery into sales at the lowest possible cost.

## Data Model

```
Organization (canonical, golden record)
├─ canonicalId: SHA256(country::normalizedName)[0:20]
├─ names: [aliases in NL/EN]
├─ identifiers: {rsin, kvk, anbi_status, domain}
├─ mission: freetext + embedding
├─ provenance: [{sourceId, snapshotId, fetchedAt, confidence}]
└─ confidence: {overall 0..1, perField}

Signal (event, detected buying intent)
├─ id: SHA256(orgId::type::occurredAt::sourceId)[0:20]
├─ type: grant_awarded | grant_applied | hiring_grants_role | registry_listed | ...
├─ strength: 0..1 (base weight for scoring)
├─ occurredAt: when the org showed intent
├─ payload: {funderId, grantId, amount, jobTitle, ...}
└─ provenance: {sourceId, snapshotId, sourceUrl}

AccountScore (computed, time-decayed)
├─ fit: 0..1 (mission ↔ ICP similarity)
├─ intent: 0..1 (max-weighted recent signal)
├─ timing: 0..1 (recency decay, 30-day half-life)
├─ reachability: 0..1 (ethical channel availability)
├─ score: 0..100 (composite: 0.40×fit + 0.30×intent + 0.20×timing + 0.10×reach)
├─ tier: hot (70+) | warm (45+) | cold_fit (fit≥0.6) | low
└─ reasons: [explainable factors + sources]
```

## Sources (Deterministic & LLM)

### Deterministic (High Confidence 0.95+)

**ANBI (NL Charity Register)**
- Source: Belastingdienst public register (3K+ orgs)
- Format: TSV, weekly
- Signals: `registry_listed` (0.2 weight)
- Extracts: RSIN, name, mission, legal status
- Confidence: 0.95

**GrantAtlas Awardees**
- Source: GrantAtlas API (grant records)
- Format: JSON, daily
- Signals: `grant_awarded` (0.8) / `grant_applied` (0.85)
- Extracts: Org name, funder, grant amount, award date
- Confidence: 0.98

### LLM-Based (Medium Confidence 0.6-0.8)

**Hiring Signals (Job Postings)**
- Source: Job boards (Firecrawl scrape)
- Format: HTML → LLM extraction
- Signals: `hiring_grants_role` (0.9 weight, high intent)
- Extracts: Org name, job title, role match to grants domain
- Confidence: 0.6-0.8 (depends on extraction quality)

## Pipeline Stages

### 1. Fetch
```
HTTP provider     → GET URL, download bytes
GrantAtlas API    → Query /awardees?filters=...
Firecrawl         → Scrape HTML, extract text
```

### 2. Capture (GCS)
```
gs://PROJECT-grantscout-raw/raw/anbi-nl/2026-02-23T03:00:00Z.bin
├─ Immutable snapshot
├─ Versioned by timestamp
├─ Indexed by sourceId + date
└─ Retention: 7 days (lifecycle policy)
```

### 3. Extract
```
ANBI TSV parser
├─ Lines → columns (RSIN, Naam, Doelstelling, Status)
├─ Filter: non-empty RSIN + name
├─ Output: Organization + registry_listed Signal

GrantAtlas JSON parser
├─ Parse awardee records
├─ Dedup by awardee_name + funder + grant
├─ Output: Organization + grant_{awarded,applied} Signal

Hiring LLM extractor (Gemini)
├─ Input: job posting text
├─ Prompt: extract org name, match to grants domain
├─ Output: Organization + hiring_grants_role Signal
```

### 4. Normalize
```
Zod validation (OrgSchema, SignalSchema)
├─ Type check: country ISO-2, confidence 0..1, enum values
├─ Per-field confidence: RSIN 1.0, mission 0.8, etc.
├─ Error collection: invalid → reviewQueue

Determinism guarantee
├─ Same input → same output
├─ Hash-based IDs for idempotency
└─ Retry-safe: re-run on failure, no duplicates
```

### 5. Resolve (Entity Dedup)
```
Group by RSIN (highest confidence)
├─ Merge: all names, latest mission, union identifiers
├─ Merge provenance: track all sources that know this org

Then by normalizedName + country
├─ Catch spelling variations, name changes

Output: Canonical org map
├─ orgId → merged Organization record
└─ All provenance preserved (multi-source merge)
```

### 6. Score
```
Fit (embedding similarity)
├─ Embed org mission (Gemini API or keyword-based mock)
├─ Compute ICP centroid from GrantMaster customer missions
├─ Cosine similarity: org ↔ centroid = Fit [0..1]

Intent (signal strength)
├─ Max-weighted active signal
├─ grant_awarded: 0.8, grant_applied: 0.85, hiring: 0.9, registry: 0.2
├─ Confidence-scaled: weight × signal.confidence

Timing (recency decay)
├─ Exponential: decay = 2^(-age_days / 30)
├─ Strongest timing among high-weight signals (≥0.5)

Reachability (channel quality)
├─ Default 0.8 (assumed GDPR-compliant orgs)
├─ TODO: improve from website analysis, contact verification

Composite (weighted blend)
├─ 0.40×Fit + 0.30×Intent + 0.20×Timing + 0.10×Reachability = raw
├─ Multiply by 100 → score [0..100]
├─ Tier based on score + fit thresholds

Explainability
├─ reasons: [{factor, detail, weight, sourceId}]
├─ Example: "grant_awarded on 2026-01-15 (0.8 weight), ICP fit 0.72 (0.40 weight)"
└─ Enables sales team to understand "why now, why this org"

Persistence (scoreAndPersist, runs inline in the sensor)
├─ Writes /accountScores/{orgId} for every resolved org after ingest
├─ Enqueues low-confidence orgs (confidence < 0.6) into /reviewQueue
└─ Non-fatal: a scoring error never fails the ingest
```

## Firestore Schema

```
/organizations/{canonicalId}
├─ names, type, country, identifiers
├─ mission, themes, sizeBand
├─ embedding (Gemini), mergedFrom (dedup history)
├─ provenance: [{sourceId, snapshotId, fetchedAt, confidence}]
├─ confidence: {overall 0..1, perField}
├─ optedOut: bool (GDPR opt-out suppresses everywhere)
├─ createdAt, updatedAt

/signals/{signalId}
├─ orgId, type, strength
├─ occurredAt (event time), detectedAt (discovery time)
├─ payload: {funderId, grantId, amount, jobTitle, ...}
├─ provenance: {sourceId, snapshotId, sourceUrl}
├─ confidence: {overall}

/accountScores/{orgId}
├─ fit, intent, timing, reachability, score
├─ tier: hot|warm|cold_fit|low
├─ reasons: [{factor, detail, weight, sourceId}]
├─ contributingSignals: [signalIds]
├─ computedAt, modelVersion

/syncLogs/{auto-id}            # one doc per pipeline run (the console's "Pipeline Runs")
├─ sourceId | service (hubspot), timestamp (ISO string)
├─ status: success | error | dry-run | queued (console-triggered) | running
├─ orgsIngested, signalsIngested, scored, queuedForReview
├─ snapshotId, error (if any)

/sources/{id}
├─ name, country, provider, extractionMethod
├─ schedule (cron), enabled, license
├─ fetchConfig: {url, format, ...}
└─ writers: pipeline (ingest) + console (enable/disable, edit, add)

/reviewQueue/{id}              # dual-writer: pipeline enqueues, console decides
├─ orgId, title, priority: high|medium|low
├─ reason, submittedBy, createdAt
├─ status: pending | approved | rejected
└─ reviewedBy, reviewedAt (set by the console)

/settings/{console}            # console-owned configuration (single doc)
├─ autoRunEnabled, emailOnFailure, debugLogging
├─ minRelevanceScore, minFitScore
└─ updatedAt, updatedBy
```

## Admin Console (Frontend)

A React admin console (`console/`) gives the GrantMaster team eyes on the
pipeline and a place to action it. It reads and writes Firestore **directly**
via the Firebase Web SDK — there is no separate API tier, so the **security
rules are the API contract**.

```
Browser (team member)
│
├─ Firebase Auth ──► ID token (email_verified + @grantmaster.nl)
│
└─ Firestore Web SDK
     ├─ reads  ─► syncLogs · organizations · accountScores · signals
     │            sources · reviewQueue · settings
     └─ writes ─► reviewQueue (approve/reject) · sources (toggle/edit/add)
                  settings (save) · syncLogs (queue a manual run)
```

**Stack:** React 19 · Vite · TypeScript · Tailwind v4 · React Router ·
TanStack Query (server cache) · Firebase v12 · lucide-react.

**Data layer (`console/src/data/`):** typed hooks per collection, Firestore
converters (Timestamp/ISO → `Date`), and a query-key factory. Reads use React
Query; the monitoring screens (Pipeline Runs, Review Queue) use Firestore
`onSnapshot` for **real-time** updates; writes are React Query mutations.

| Route | Reads | Writes |
|-------|-------|--------|
| `/` Overview | counts + recent runs | — |
| `/runs`, `/runs/:id` | syncLogs (live) | trigger run |
| `/sources` | sources | enable/disable · edit · add |
| `/organizations`, `/organizations/:id` | organizations (+ score + signals) | — |
| `/review` | reviewQueue pending (live) | approve / reject |
| `/scoring` | accountScores (joined to org names) | — |
| `/settings` | settings/console | save config |

**Local development:** runs against the **Firebase Emulator Suite** (Auth +
Firestore) seeded by `console/scripts/seed-emulator.ts`, with a "Dev sign-in"
button when `VITE_USE_EMULATOR=true` — QA needs no Google account and never
touches production. Emulator UI `:4000`, console `:5173`.

**Deploy:** static build to **Firebase Hosting** (`firebase.json` → site
`grantscout-88aa6`, SPA rewrite to `index.html`).

## Cloud Infrastructure

```
Cloud Scheduler
│
└─► Cloud Run Job (grantscout sensor)
    │
    ├─ Fetch & store snapshot (GCS)
    │
    ├─ Extract → Normalize → Resolve
    │
    ├─ Write organizations + signals to Firestore
    │
    ├─ Score inline (scoreAndPersist)
    │   ├─ Write accountScores
    │   └─ Enqueue low-confidence orgs → reviewQueue
    │
    └─ HubSpot Sync (rank prospects → upsert companies, dry-run by default)

Firestore ──► Admin Console (Firebase Hosting)
           └─ team reads dashboards + actions review/sources/settings

Monitoring
├─ Cloud Logging (audit trail, error detection)
├─ Cloud Monitoring (metrics, alerting)
└─ Cloud Trace (latency breakdown)
```

### Deployment Tiers

```
Development (Local)
├─ Firebase Emulator Suite (Auth + Firestore) + seed script
├─ Console: VITE_USE_EMULATOR=true → "Dev sign-in" (no Google OAuth)
├─ GCS (local mock or dev bucket)
├─ Gemini mock (keyword-based embeddings)
└─ HubSpot: dry-run only

Staging (GCP Project)
├─ Real Firestore (separate database)
├─ Real GCS bucket
├─ Real Gemini API
├─ Real HubSpot (dry-run flag)
└─ CI/CD via Cloud Build

Production (Main GCP Project)
├─ Real Firestore (prod database)
├─ Real GCS with lifecycle policies
├─ Real Gemini API (production quota)
├─ Real HubSpot (live upserts)
├─ Cloud Monitoring dashboards + alerting
└─ Backups: daily Firestore export
```

## Cost Model (NL-First, Lean)

| Component | Volume | Cost | Notes |
|-----------|--------|------|-------|
| GCS Snapshots | 1.5 GB/mo | €0.05 | 7-day retention |
| Firestore | 3K docs | €0.20 | 1K ops/day |
| Gemini Embeddings | 1K/day | €0.60 | 0.02 per 1K |
| Cloud Run | 3×5min/day | €0.25 | 3 jobs × CPU-seconds |
| **Total** | | **~€1.10** | **Well under €10/mo** |

## Security & Compliance

### GDPR/AVG Guardrails

✅ **Data Minimization**: Org-level only, no personal data  
✅ **Lawful Basis**: Legitimate interest (B2B prospecting)  
✅ **Provenance**: Every record stamped (source, snapshot, when)  
✅ **Confidence**: Per-field (enables data quality decisions)  
✅ **Opt-Out**: `optedOut` flag suppresses everywhere  
✅ **No Web Tracking**: Public records + consented GrantAtlas search only  
✅ **Retention**: Raw snapshots auto-delete after 7 days  

### Firestore Security Rules

`isService()` = no auth uid (Cloud Run ingest). `isTeam()` = `email_verified`
&& email on an allowed domain (`@grantmaster.nl` or `@gible.com`), matched with
RE2 `matches()` (Firestore rules have no `endsWith`). The emulator dev user
`dev@grantmaster.nl` satisfies `isTeam()`.

```
organizations: ✓ Service writes,        ✓ Team reads
signals:       ✓ Service writes,        ✓ Team reads
accountScores: ✓ Service writes,        ✓ Team reads
syncLogs:      ✓ Service + Team writes, ✓ Team reads   (team may enqueue a manual run)
sources:       ✓ Service + Team writes, ✓ Team reads   (console toggles/edits config)
reviewQueue:   ✓ Team read/write                       (pipeline enqueues, console decides)
settings:      ✓ Team read/write                       (console config; doc: console)
rawSnapshots:  ✓ Service writes,        ✗ Disabled reads (use GCS)
```

## Roadmap

### Phase 1 ✅ Complete
- ANBI + GrantAtlas extractors
- Scoring formula (Fit×Intent×Timing×Reachability)
- HubSpot dry-run sync
- End-to-end testing

### Phase 2 ✅ Complete
- Hiring signals (LLM-based)
- Cloud Run deployment (Dockerfile, Cloud Build)
- Firestore persistence (orgs, signals, scores, review queue)
- Admin console wired to Firestore (live dashboards + review/source/settings actions, real-time)
- Monitoring & operations

### Phase 3 (Next)
- Organic/viral loops (Beacon: content, referral, funder-led)
- ✅ Real Gemini embeddings (`gemini-embedding-001`, key-gated with mock fallback)
- ✅ GrantAtlas awardee provider (reads API when configured, sample fallback otherwise)
- HubSpot live sync + sync tracking
- GrantAtlas funder linking

### Phase 4
- ML-trained Fit model (replace embeddings)
- EU/world expansion (beyond NL)
- Learning loop (win rate feedback)

## Testing Strategy

```
Unit Tests (50 tests)
├─ Extractors: ANBI, GrantAtlas, Hiring
├─ Normalizer: Zod validation, confidence
├─ Resolver: dedup, merging
├─ Scorer: formula, tiering, reasons
├─ Embeddings: similarity, centroid
└─ HubSpot: ranking, payload

Integration Tests
├─ Full pipeline: extract → normalize → resolve → score
├─ Multiple sources: ANBI + GrantAtlas + Hiring
├─ End-to-end: ingest 5 orgs, score, rank top 3

Performance Tests (TBD)
├─ 10K org ingest latency
├─ Concurrent Firestore writes
├─ Gemini API rate limit handling

Compliance Tests
├─ Opt-out suppression
├─ Provenance capture
├─ Confidence per field
└─ GDPR audit trail
```

## Key Design Decisions

1. **Deterministic IDs**: Hash-based → idempotent re-runs, safe retries
2. **Provenance on Every Record**: Enables trust, data lineage, regulatory compliance
3. **Per-Field Confidence**: Quality signal for downstream decisions (what to trust, what to review)
4. **Scoring Formula Weights**: 0.40×Fit (ICP match) + 0.30×Intent (signal activity) prevents false positives
5. **Firestore (not SQL)**: Schema-less, real-time triggers, built-in sync to GCS backups
6. **Cloud Run (not servers)**: Scales to zero, pay-per-execution, easy scheduling
7. **Dry-Run HubSpot**: Review payloads before live sync, low-risk launch
8. **NL-First**: Start with most accessible data (ANBI, GrantAtlas), expand later

## Related Systems

- **GrantAtlas**: Supply-side (grants + funders) — source of awardee lists
- **GrantMaster**: Do-the-work (compliance, finance) — customer base for ICP
- **GrantMaster Sales Tools**: Consume ranked prospects from HubSpot feed
