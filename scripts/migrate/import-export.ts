/**
 * Import a one-off export of the old Firestore database into the local store.
 *
 *   DATA_DIR=/var/lib/grantscout npx tsx scripts/migrate/import-export.ts <export-dir>
 *
 * <export-dir> holds one `<collection>.jsonl` per collection, each line `{"id": "...", "data": {...}}`
 * (written by infra/legacy-gcp/export-firestore.mjs). Idempotent: documents are upserted by id, so a re-run
 * changes nothing. Run it with the service STOPPED and as the service user, then check the printed counts.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Collection, WriteBatch, closeStore } from '../../src/core/store.js';

const KNOWN = new Set([
  'sources', 'organizations', 'signals', 'accountScores', 'reviewQueue', 'syncLogs', 'grants', 'settings',
]);

/** Firestore Timestamps export as { _seconds, _nanoseconds } (or seconds/nanoseconds): store ISO strings instead. */
export function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const secs = o._seconds ?? o.seconds;
    const keys = Object.keys(o);
    if (typeof secs === 'number' && keys.length <= 2 && keys.every((k) => /^_?(seconds|nanoseconds)$/.test(k))) {
      const nanos = (o._nanoseconds ?? o.nanoseconds ?? 0) as number;
      return new Date(secs * 1000 + Math.floor(nanos / 1e6)).toISOString();
    }
    return Object.fromEntries(keys.map((k) => [k, normalise(o[k])]));
  }
  return value;
}

export async function importExport(dir: string): Promise<Record<string, { read: number; total: number }>> {
  if (!existsSync(dir)) throw new Error(`export directory not found: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) throw new Error(`no .jsonl files in ${dir}`);
  const report: Record<string, { read: number; total: number }> = {};

  for (const file of files) {
    const name = file.replace(/\.jsonl$/, '');
    if (!KNOWN.has(name)) {
      console.warn(`skipping unknown collection file: ${file}`);
      continue;
    }
    const coll = new Collection(name);
    const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l.trim());
    let batch = new WriteBatch();
    let pending = 0;
    let read = 0;
    for (const [i, line] of lines.entries()) {
      let row: { id?: unknown; data?: unknown };
      try { row = JSON.parse(line); } catch { throw new Error(`${file}:${i + 1}: not valid JSON`); }
      if (typeof row.id !== 'string' || !row.id || typeof row.data !== 'object' || row.data === null) {
        throw new Error(`${file}:${i + 1}: expected {"id": string, "data": object}`);
      }
      batch.set(coll.doc(row.id), normalise(row.data) as Record<string, unknown>);
      read++;
      if (++pending === 400) { await batch.commit(); batch = new WriteBatch(); pending = 0; }
    }
    await batch.commit();
    report[name] = { read, total: coll.count() };
  }
  return report;
}

if (process.argv[1]?.endsWith('import-export.ts')) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npx tsx scripts/migrate/import-export.ts <export-dir>');
    process.exit(2);
  }
  importExport(dir)
    .then((report) => {
      for (const [name, r] of Object.entries(report)) console.log(`OK ${name}: ${r.read} read, ${r.total} in store`);
      closeStore();
    })
    .catch((e) => {
      console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
