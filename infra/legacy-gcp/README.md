# Retired Google Cloud deployment

GrantScout used to run on Cloud Run with Firestore, a GCS bucket and the Gemini API, driven by a scheduled GitHub
Actions workflow. Since October 2026 it runs on the Mac Mini (`infra/mini/README.md`). The files here are kept for
reference only; nothing in the repo uses them, and `pipeline.yml` is no longer under `.github/workflows`.

| File | Was |
|---|---|
| `Dockerfile`, `cloudbuild.yaml` | Cloud Run image and build |
| `firebase.json`, `firestore.rules`, `firestore.indexes.json` | Firestore rules, indexes and emulator config |
| `pipeline.yml` | the daily GitHub Actions run that wrote to production Firestore |
| `export-firestore.mjs` | one-off export of the old database to JSONL (needs a Google credential; untested) |

## Bringing the old data across (optional)
1. Export on a machine that has the Google credential (not the Mini machine): see the header of `export-firestore.mjs`.
2. Copy the export directory into the machine, stop the service, and import as the service user:
   ```bash
   orb -m grantscout -u root systemctl stop grantscout
   COPYFILE_DISABLE=1 tar -C ./export -cf - . | orb -m grantscout -u root bash -c \
     'install -d -o grantscout -g grantscout -m 0750 /var/lib/grantscout/export && tar -x --no-same-owner -C /var/lib/grantscout/export && chown -R grantscout: /var/lib/grantscout/export'
   orb -m grantscout -u root sudo -H -u grantscout bash -c \
     'cd /opt/grantscout && DATA_DIR=/var/lib/grantscout npx tsx scripts/migrate/import-export.ts /var/lib/grantscout/export'
   ```
   Every line must start with `OK` and the counts must match the export's. The import is idempotent.
3. Start the service again and delete `/var/lib/grantscout/export` after the first good nightly backup.

After the data is across (or you decide not to bring it), the Google Cloud project, its service-account key and the
repository secrets (`GCP_SA_KEY`, `GEMINI_API_KEY`, `GRANTATLAS_FB_API_KEY`) can be retired.
