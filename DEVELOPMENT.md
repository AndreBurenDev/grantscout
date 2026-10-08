# GrantScout Development Guide

> **Outdated: describes the retired Google Cloud deployment.** GrantScout now runs on the Mac Mini with SQLite and
> Ollama. See [infra/mini/README.md](infra/mini/README.md); the old setup is archived in [infra/legacy-gcp](infra/legacy-gcp/README.md).

## Local testing

### Test the ANBI extraction pipeline in-memory
```bash
npx tsx scripts/test-anbi.ts
```

This runs the full pipeline (extract → normalize → resolve → score) with sample ANBI data and shows results without needing Firestore.

### Prepare for Firestore integration
1. Set up a local Firestore emulator or use a GCP dev project
2. Configure `.env` with `GCP_PROJECT_ID` and credentials
3. Implement Firestore initialization in `src/core/firestore.ts` (currently uses admin SDK)

### Run tests
```bash
npm test                 # Run once
npm run test:watch      # Watch mode
```

## Phase 1 acceptance checklist

- [x] ANBI extractor parses TSV, emits organizations + signals
- [x] Normalizer validates via Zod with per-field confidence
- [x] Resolver deduplicates, merges provenance
- [x] Account Score computes with reasons and tiering
- [x] Pipeline test script validates end-to-end
- [ ] Real Firestore sync (needs GCP setup)
- [ ] GrantAtlas awardee integration
- [ ] Dry-run HubSpot sync logging
- [ ] Real ANBI register fetch (currently skipped in local test)

## Architecture overview

```
Source → HTTP Fetch → GCS Snapshot → Extract
         ↓
    Normalize (Zod validation)
         ↓
    Resolve (dedup, merge provenance)
         ↓
    Account Score (Fit×Intent×Timing×Reachability)
         ↓
    Firestore Write + HubSpot Sync
```

Each step is independently testable:
- Extractors: deterministic (ANBI, GrantAtlas) or LLM-based (hiring, web)
- Normalizers: Zod schemas + confidence scoring
- Resolver: entity dedup by identifiers
- Scorer: composite formula with explainable reasons

## Source registry

Sources are configured in `src/sources/registry.ts`:

| Source | Type | Status | Next |
|--------|------|--------|------|
| ANBI (NL) | Deterministic TSV | ✓ Implemented | Wire real fetch |
| GrantAtlas awardees | Deterministic JSON | Stub | Implement API integration |
| Hiring (NL) | LLM extraction | Stub | Enable after ANBI proven |

## Cost targets
- **Storage**: ~€1/month (GCS for raw snapshots)
- **Compute**: ~€2-5/month (Cloud Run on demand, Gemini API usage)
- **Database**: ~€0 (Firestore free tier for Phase 1 scale)

## GDPR / AVG compliance
- Every record has provenance (source, snapshot, fetch time)
- Confidence stamped on all data (per-field for orgs)
- Opt-out support (`organizations.optedOut` suppresses everywhere)
- Public-record + consented first-party only (no web tracking)
- Deterministic IDs for idempotent ingest
