# GrantScout Operations Guide

> **Outdated: describes the retired Google Cloud deployment.** GrantScout now runs on the Mac Mini with SQLite and
> Ollama. See [infra/mini/README.md](infra/mini/README.md); the old setup is archived in [infra/legacy-gcp](infra/legacy-gcp/README.md).

## System Overview

GrantScout is a scheduled data pipeline that ingests organization and signal data, scores prospects, and syncs to HubSpot. It runs as serverless Cloud Run jobs triggered daily by Cloud Scheduler.

```
┌─────────────────────────────────────────────────────────────┐
│                    GRANTSCOUT PIPELINE                      │
└─────────────────────────────────────────────────────────────┘

Cloud Scheduler (cron)
    ↓
Cloud Run Job (sensor)
    ├─ Fetch (HTTP / GrantAtlas API / Firecrawl)
    ├─ Store (GCS immutable snapshot)
    ├─ Extract (ANBI TSV / GrantAtlas JSON / Hiring LLM)
    ├─ Normalize (Zod validation)
    ├─ Resolve (dedup, merge provenance)
    └─ Store (Firestore organizations + signals)
    ↓
Account Scorer (triggered by signal ingestion)
    ├─ Compute embeddings (Gemini API)
    ├─ Score prospects (Fit×Intent×Timing×Reachability)
    └─ Store (Firestore accountScores)
    ↓
HubSpot Sync (scheduled or event-driven)
    ├─ Rank prospects (by tier, then score)
    ├─ Map to HubSpot properties
    └─ Upsert companies (dry-run or live)
```

## Data Flow

### 1. Daily Ingestion (03:00 UTC)

**ANBI Sensor** (Monday-Sunday)
```
Belastingdienst ANBI register (TSV)
    ↓
HTTP fetch (700 KB, 3K+ rows)
    ↓
GCS snapshot: gs://PROJECT-grantscout-raw/raw/anbi-nl/2026-02-23T03:00:00Z.bin
    ↓
TSV parse → Organizations + registry_listed signals
    ↓
Firestore: organizations, signals
```

**GrantAtlas Sensor** (Daily 04:00 UTC)
```
GrantAtlas API (awardee/applicant lists)
    ↓
JSON fetch (varies)
    ↓
GCS snapshot
    ↓
JSON parse → Organizations + grant_awarded/grant_applied signals
    ↓
Firestore: organizations (merged), signals
```

**Hiring Signals Sensor** (Daily 05:00 UTC)
```
Job board scrape (Firecrawl)
    ↓
GCS snapshot
    ↓
Job postings → LLM extraction (org name, role)
    ↓
Organizations + hiring_grants_role signals
    ↓
Firestore
```

### 2. Scoring & Activation

After each sensor completes:
1. Firestore trigger: new signals → scoring function
2. Score computed: Fit (embeddings) × Intent (signal type) × Timing (decay) × Reachability
3. Tiered: hot (70+) / warm (45+) / cold_fit (Fit≥0.6) / low
4. HubSpot sync: top 100 prospects, dry-run or live

## Monitoring & Alerts

### Key Metrics

- **Ingestion latency**: Time from fetch to Firestore (target <5min)
- **Coverage**: Orgs ingested per day (target 3K+ ANBI, 500+ GrantAtlas)
- **Signal quality**: Low-confidence signals routed to review queue
- **HubSpot sync**: Success rate, upsert latency

### Log Queries

```bash
# Failed sensor runs
gcloud logging read "resource.type=cloud_run_job AND severity=ERROR" --limit=10

# ANBI ingestion metrics
gcloud logging read "resource.type=cloud_run_job AND jsonPayload.sourceId=anbi-nl" \
  --limit=10 \
  --format='table(timestamp,jsonPayload.orgsIngested,jsonPayload.signalsIngested)'

# Low-confidence orgs
gcloud logging read "resource.type=firestore_database AND jsonPayload.confidence.overall<0.6" \
  --limit=20
```

### Alerting

Create Cloud Monitoring alerts:

```bash
# Alert on sensor failure
gcloud alpha monitoring policies create \
  --notification-channels=CHANNEL_ID \
  --display-name="GrantScout Sensor Failure" \
  --condition="resource.type=cloud_run_job AND metric.type=run.googleapis.com/job_execution_count AND metric.labels.result_type=failure"

# Alert on high error rate
gcloud alpha monitoring policies create \
  --notification-channels=CHANNEL_ID \
  --display-name="GrantScout High Error Rate" \
  --condition="resource.type=cloud_run_job AND metric.type=logging.googleapis.com/log_entry_count AND metric.labels.log_name=projects/*/logs/cloud_run_job AND severity=ERROR"
```

## Common Tasks

### View Recent Ingestion

```bash
# Last ANBI run
gcloud run jobs logs grantscout-anbi-sensor --limit=50

# Last 10 orgs ingested
gcloud firestore export gs://PROJECT-grantscout-exports/latest \
  --collection-ids=organizations

# Orgs by confidence
gcloud firestore export gs://PROJECT-grantscout-exports/low-confidence \
  --collection-ids=organizations \
  --query="confidence.overall < 0.6"
```

### Manual Sensor Runs

```bash
# Test ANBI in sandbox
gcloud run jobs execute grantscout-anbi-sensor \
  --region=us-central1 \
  --wait

# Run with custom args
gcloud run jobs execute grantscout-anbi-sensor \
  --region=us-central1 \
  --args="--source=anbi-nl" \
  --wait
```

### Firestore Maintenance

```bash
# Backup collections
gcloud firestore export gs://PROJECT-grantscout-backups/daily-$(date +%Y%m%d)

# Delete low-confidence orgs (caution!)
gcloud firestore delete-documents organizations \
  --query="confidence.overall < 0.5"

# Re-score all orgs (trigger account scorer)
gcloud firestore export gs://PROJECT-grantscout-exports/rescore-$(date +%s)
```

### HubSpot Dry-Run Review

```bash
# View latest dry-run payload
gcloud logging read "resource.type=cloud_run_job AND jsonPayload.service=hubspot" \
  --limit=1 \
  --format=json | jq '.[] | select(.jsonPayload.status=="dry-run") | .jsonPayload.payloadSample'

# Enable real sync (caution!)
# Update Cloud Run job env: HUBSPOT_SYNC_ENABLED=true
gcloud run jobs update grantscout-hubspot-sync \
  --set-env-vars=HUBSPOT_SYNC_ENABLED=true
```

## Disaster Recovery

### Restore from Backup

```bash
# List available backups
gsutil ls gs://PROJECT-grantscout-backups/

# Restore specific backup (creates new collection)
gcloud firestore import gs://PROJECT-grantscout-backups/daily-20260223/
```

### Replay Snapshot

```bash
# Re-extract from stored GCS snapshot
# 1. Get snapshot ID from syncLog
gcloud firestore export gs://PROJECT-grantscout-exports/logs

# 2. Re-run extraction with same snapshot
# TODO: implement snapshot replay
```

### Reset & Reseed

```bash
# Delete all data (caution!)
gcloud firestore delete-documents --all

# Re-run all sensors
gcloud run jobs execute grantscout-anbi-sensor --wait
gcloud run jobs execute grantscout-grantatlas-sensor --wait
gcloud run jobs execute grantscout-hiring-sensor --wait
```

## Performance Tuning

### Batch Sizes

Adjust in `src/orchestrator/hubspot.ts`:
- `rankProspects(prospects, topN)`: Default 100
- Increase for more prospects, decrease for faster sync

### Scoring Thresholds

Adjust in `src/scoring/accountScore.ts`:
- `tierOf(score, fit)`: hot (70) / warm (45)
- `timingDecay()`: half-life (30 days)
- `SIGNAL_WEIGHTS`: intent contributions

### Cache

Embeddings are cached in-memory. For distributed:
- Implement Redis cache in `src/ai/gemini.ts`
- Cache key: SHA256(mission text)
- TTL: 7 days

## Compliance & Audit

### GDPR Audit Trail

```bash
# All ingestion events (provenance)
gcloud logging read "resource.type=firestore_database AND jsonPayload.provenance" \
  --format=json | jq '.[] | {timestamp, sourceId: .jsonPayload.provenance.sourceId, confidence: .jsonPayload.confidence.overall}'

# Opt-outs honored
gcloud firestore export gs://PROJECT-grantscout-exports/optouts \
  --collection-ids=organizations \
  --query="optedOut==true"

# Signal retention (delete after 2 years)
gcloud logging read "resource.type=firestore_database AND timestamp<2024-01-01" \
  --collection-ids=signals \
  --delete-documents
```

### Data Minimization

```bash
# Review raw snapshots (should be deleted after processing)
gsutil ls -h gs://PROJECT-grantscout-raw/raw/

# Delete raw snapshots older than 30 days
gsutil -m rm -r gs://PROJECT-grantscout-raw/raw/*/$(date -d '30 days ago' +%Y-%m-%d)*
```

## Cost Control

### Monthly Quota

- ANBI: 1 run/week × 700 KB = ~3 MB GCS = €0.05/mo
- GrantAtlas: 1 run/day × 50 MB = ~1.5 GB GCS = €0.05/mo
- Firestore: 3K orgs × 500 signals = ~1M docs = €0.20/mo (operations)
- Gemini: 1K embeddings/day × 0.02 = €0.60/mo
- Cloud Run: 3 jobs × 5 min = €0.25/mo
- **Total: ~€1.15/mo** (well under €10 target)

### Optimization

```bash
# Monitor GCS usage
gsutil du -sh gs://PROJECT-grantscout-raw/

# Monitor Firestore usage
gcloud firestore databases describe --region=us-central1 | grep size

# Set lifecycle policy (delete raw snapshots after 7 days)
cat > /tmp/lifecycle.json <<EOF
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "Delete"},
        "condition": {"age": 7}
      }
    ]
  }
}
EOF
gsutil lifecycle set /tmp/lifecycle.json gs://PROJECT-grantscout-raw/
```

## Troubleshooting Guide

| Issue | Cause | Fix |
|-------|-------|-----|
| Firestore quota exceeded | Too many writes | Batch writes, reduce frequency |
| Gemini API errors | Rate limit / quota | Check quota, wait 1 hour |
| Sensor timeout | Large dataset | Increase Cloud Run timeout to 3600s |
| HubSpot sync fails | Invalid credentials | Verify HUBSPOT_ACCESS_TOKEN |
| Low coverage | Source API down | Check source status, retry manually |
| High error rate | Schema mismatch | Re-validate extractors vs source format |

See `DEPLOYMENT.md` for setup and `DEVELOPMENT.md` for local testing.
