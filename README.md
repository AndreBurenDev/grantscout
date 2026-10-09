# GrantScout

Internal demand-side intelligence for GrantMaster. Finds the right NGO organizations to
become GrantMaster customers and ranks them by Fit × Intent × Timing × Reachability.

Mirror of GrantAtlas (which maps grants + funders); GrantScout maps the orgs that seek them.

## Modules
- **Sensor** — signal ingestion (ANBI, GrantAtlas awardees, hiring)
- **Scorer** — Account Score + canonical demand graph
- **Beacon** — feeds organic/viral acquisition loops (later phases)
- **Orchestrator** — ranks prospects → HubSpot / team

## Where it runs
On the Mac Mini, in its own isolated OrbStack machine: one process serves the scheduler, the admin API and the
Console. Data is a local SQLite file plus raw snapshots on disk; AI is Ollama on the host. No cloud runtime, no cloud
credential. Runbook: [infra/mini/README.md](infra/mini/README.md). The retired Google Cloud setup is in
[infra/legacy-gcp](infra/legacy-gcp/README.md).

## Quick start (development)
```bash
npm install --include=dev        # .npmrc omits dev dependencies by default
npm test
npm run pipeline:once -- --source anbi-nl     # one run from the CLI; data lands in ./.data
npm run dev                      # API on :3300, acting as dev@localhost
npm run dev:console              # Console on :3100, proxying /api to :3300
```

## Ethics & compliance
Public-record + consented first-party data only. GDPR/AVG legitimate-interest basis,
provenance on every record, frictionless opt-out (`organizations.optedOut`). No tracking
of individuals across the web. See the handoff doc §6.
