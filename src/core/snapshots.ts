// Immutable raw snapshots on local disk (was a GCS bucket). The key is a relative path under the snapshots
// directory, e.g. "raw/anbi-nl/2026-10-08T04-00-00.000Z.bin", and is stored on records as their snapshotId.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { config } from './config.js';

function pathFor(key: string): string {
  const rel = normalize(key);
  if (rel.startsWith('..') || rel.startsWith('/')) throw new Error(`invalid snapshot key: ${key}`);
  return join(config.snapshotsDir, rel);
}

export async function storeRawSnapshot(key: string, data: string | Buffer): Promise<void> {
  const p = pathFor(key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data, { flag: 'wx' }); // never overwrite: snapshots are immutable
}

export async function getRawSnapshot(key: string): Promise<Buffer> {
  return readFileSync(pathFor(key));
}
