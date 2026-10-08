// One-off export of the retired Firestore database to JSONL, for scripts/migrate/import-export.ts.
// NOT part of the runtime and NOT run on the Mini machine: it needs a Google credential, which the machine never has.
// UNTESTED against the live project (written after the cloud dependencies were removed); read the counts it prints.
//
//   mkdir /tmp/gs-export-tool && cd /tmp/gs-export-tool && npm init -y >/dev/null && npm i firebase-admin
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json GCP_PROJECT_ID=grantscout-88aa6 \
//     node /path/to/grantscout/infra/legacy-gcp/export-firestore.mjs ./export
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const admin = require('firebase-admin');

const out = process.argv[2];
if (!out) { console.error('usage: node export-firestore.mjs <out-dir>'); process.exit(2); }
admin.initializeApp({ projectId: process.env.GCP_PROJECT_ID });
const db = admin.firestore();
mkdirSync(out, { recursive: true });

for (const name of ['sources', 'organizations', 'signals', 'accountScores', 'reviewQueue', 'syncLogs', 'grants', 'settings']) {
  const snap = await db.collection(name).get();
  writeFileSync(join(out, `${name}.jsonl`), snap.docs.map((d) => JSON.stringify({ id: d.id, data: d.data() })).join('\n') + (snap.size ? '\n' : ''));
  console.log(`${name}: ${snap.size}`);
}
