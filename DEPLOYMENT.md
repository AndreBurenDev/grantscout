# GrantScout Deployment Guide

> **Outdated: describes the retired Google Cloud deployment.** GrantScout now runs on the Mac Mini with SQLite and
> Ollama. See [infra/mini/README.md](infra/mini/README.md); the old setup is archived in [infra/legacy-gcp](infra/legacy-gcp/README.md).

## Prerequisites

- GCP project with Firestore, GCS, and Cloud Run enabled
- Service account with appropriate permissions
- Docker (for local testing)
- gcloud CLI configured

## Environment Variables

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Required for production:
```bash
GCP_PROJECT_ID=your-project-id
FIRESTORE_DATABASE_ID=(default)
GCS_RAW_BUCKET=grantscout-raw
GEMINI_API_KEY=your-gemini-api-key
TYPESENSE_HOST=your-typesense-host
TYPESENSE_API_KEY=your-typesense-key
GRANTATLAS_READ_API_URL=https://api.grantatlas.com/...
GRANTATLAS_API_KEY=your-api-key
HUBSPOT_ACCESS_TOKEN=your-hubspot-token
HUBSPOT_SYNC_ENABLED=true  # Production: enable sync
```

## Local Testing

### Without Firestore (Development)

```bash
# Test full pipeline locally
npx tsx scripts/test-pipeline.ts

# Run all tests
npm test
```

### With Firestore Emulator

```bash
# Start emulator (requires gcloud CLI)
gcloud emulators firestore start

# In another terminal, set env
export FIRESTORE_EMULATOR_HOST=localhost:8080

# Run sensor
npm run pipeline:once -- --source anbi-nl
```

## Docker Build & Test

```bash
# Build locally
docker build -t grantscout:latest .

# Run ANBI pipeline
docker run \
  -e GCP_PROJECT_ID=grantscout-dev \
  -e FIRESTORE_DATABASE_ID='(default)' \
  grantscout:latest --source anbi-nl

# Run GrantAtlas pipeline
docker run \
  -e GCP_PROJECT_ID=grantscout-dev \
  grantscout:latest --source grantatlas-awardees

# Run hiring signals pipeline
docker run \
  -e GCP_PROJECT_ID=grantscout-dev \
  grantscout:latest --source hiring-nl
```

## Cloud Run Deployment

### 1. Set up GCP resources

```bash
export PROJECT_ID=your-gcp-project
export REGION=us-central1

# Enable APIs
gcloud services enable \
  firestore.googleapis.com \
  storage.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  pubsub.googleapis.com \
  cloudbuild.googleapis.com

# Create GCS bucket for raw snapshots
gsutil mb gs://${PROJECT_ID}-grantscout-raw

# Create Firestore database
gcloud firestore databases create --region=$REGION
```

### 2. Build and push container

```bash
# Build locally and push to Artifact Registry
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions COMMIT_SHA=$(git rev-parse --short HEAD)
```

### 3. Deploy sensor as Cloud Run job

```bash
# Create ANBI sensor job
gcloud run jobs create grantscout-anbi-sensor \
  --image gcr.io/${PROJECT_ID}/grantscout:latest \
  --args "--source=anbi-nl" \
  --region ${REGION} \
  --set-env-vars GCP_PROJECT_ID=${PROJECT_ID}

# Create GrantAtlas sensor job
gcloud run jobs create grantscout-grantatlas-sensor \
  --image gcr.io/${PROJECT_ID}/grantscout:latest \
  --args "--source=grantatlas-awardees" \
  --region ${REGION} \
  --set-env-vars GCP_PROJECT_ID=${PROJECT_ID}

# Create hiring sensor job
gcloud run jobs create grantscout-hiring-sensor \
  --image gcr.io/${PROJECT_ID}/grantscout:latest \
  --args "--source=hiring-nl" \
  --region ${REGION} \
  --set-env-vars GCP_PROJECT_ID=${PROJECT_ID}
```

### 4. Schedule with Cloud Scheduler

```bash
# ANBI: Weekly Monday 03:00 UTC
gcloud scheduler jobs create http grantscout-anbi-schedule \
  --location=${REGION} \
  --schedule="0 3 * * 1" \
  --http-method=POST \
  --uri=https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/jobs/grantscout-anbi-sensor:run

# GrantAtlas: Daily 04:00 UTC
gcloud scheduler jobs create http grantscout-ga-schedule \
  --location=${REGION} \
  --schedule="0 4 * * *" \
  --http-method=POST \
  --uri=https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/jobs/grantscout-grantatlas-sensor:run

# Hiring: Daily 05:00 UTC
gcloud scheduler jobs create http grantscout-hiring-schedule \
  --location=${REGION} \
  --schedule="0 5 * * *" \
  --http-method=POST \
  --uri=https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/jobs/grantscout-hiring-sensor:run
```

## Monitoring

### Logs

```bash
# Watch ANBI sensor logs
gcloud run jobs logs grantscout-anbi-sensor \
  --limit=100 \
  --follow

# Query logs by timestamp
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=grantscout-anbi-sensor" \
  --limit=50 \
  --format=json
```

### Metrics

```bash
# View Cloud Run metrics in Cloud Console
gcloud monitoring dashboards list
```

## Firestore Security Rules

Deploy rules from `firestore.rules`:

```bash
gcloud firestore rules deploy firestore.rules
```

## Cost Monitoring

```bash
# Set up budget alerts
gcloud billing budgets create \
  --billing-account=BILLING_ACCOUNT_ID \
  --display-name="GrantScout Phase 1" \
  --budget-amount=50 \
  --threshold-rule=percent=50,percent=90,percent=100
```

## Troubleshooting

### Firestore connection errors

```bash
# Check service account has Firestore permissions
gcloud projects get-iam-policy ${PROJECT_ID} \
  --flatten="bindings[].members" \
  --format='table(bindings.role)' \
  --filter="bindings.members:serviceAccount:*"
```

### GCS access denied

```bash
# Grant service account GCS permissions
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member=serviceAccount:${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com \
  --role=roles/storage.objectAdmin
```

### Gemini API quota exceeded

Monitor usage in Cloud Console and upgrade quota in Gemini API settings.

## Rollback

If issues arise:

```bash
# Revert to previous Cloud Run job revision
gcloud run jobs update grantscout-anbi-sensor \
  --image gcr.io/${PROJECT_ID}/grantscout:previous-tag
```

## Next Steps

1. Set up Firestore database and security rules
2. Configure HubSpot API credentials
3. Deploy first sensor (ANBI) to Cloud Run
4. Monitor logs and adjust thresholds
5. Enable additional sensors (GrantAtlas, Hiring)
6. Set up alerting and dashboards
