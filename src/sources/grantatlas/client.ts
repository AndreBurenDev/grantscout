import { readFileSync } from 'fs';
import { config } from '../../core/config.js';
import { projectGrant, type GrantOpportunity, type RawGrant } from './grants.js';

const SAMPLE_PATH = 'data/grantatlas-grants-sample.json';

/**
 * Fetch grant opportunities from GrantAtlas.
 *
 * GRANTATLAS_GRANTS_API_URL is the full URL of a JSON endpoint returning either an array of grants or
 * `{ grants: [...] }`; GRANTATLAS_API_KEY, when set, is sent as a Bearer token. A `file://` URL reads a local
 * export. Unset, it falls back to the committed sample so the catalog is runnable in development.
 *
 * (The earlier Firebase custom-token exchange is gone with the cloud runtime: no Google credential exists here.)
 */
export async function fetchGrants(): Promise<GrantOpportunity[]> {
  const url = config.grantatlasGrantsApiUrl;
  if (!url) {
    console.warn('[grantatlas] GRANTATLAS_GRANTS_API_URL not set — using sample opportunities');
    return (JSON.parse(readFileSync(SAMPLE_PATH, 'utf-8')) as RawGrant[]).map(projectGrant);
  }

  let body: RawGrant[] | { grants?: RawGrant[] };
  if (url.startsWith('file://')) {
    body = JSON.parse(readFileSync(url.replace('file://', ''), 'utf-8'));
  } else {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'GrantScout/1.0 (grantscout-ingestion)',
    };
    if (config.grantatlasApiKey) headers.Authorization = `Bearer ${config.grantatlasApiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GrantAtlas grants API ${res.status}: ${res.statusText}`);
    body = (await res.json()) as RawGrant[] | { grants?: RawGrant[] };
  }
  const raw = Array.isArray(body) ? body : (body.grants ?? []);
  return raw.map(projectGrant);
}
