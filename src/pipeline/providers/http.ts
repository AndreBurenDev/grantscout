import { readFileSync } from 'fs';
import { storeRawSnapshot } from '../../core/snapshots.js';

export async function fetchHttp(url: string): Promise<Buffer> {
  // Handle local file:// URLs for testing
  if (url.startsWith('file://')) {
    const path = url.replace('file://', '');
    return readFileSync(path);
  }

  // Handle HTTP(S) URLs
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'GrantScout/1.0 (grantscout-ingestion)',
      'Accept': 'text/tab-separated-values, text/plain, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Store the immutable raw snapshot on local disk; the returned key is the snapshotId on every record. */
export async function storeSnapshot(sourceId: string, data: Buffer): Promise<string> {
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const key = `raw/${sourceId}/${timestamp}.bin`;
  await storeRawSnapshot(key, data);
  return key;
}
