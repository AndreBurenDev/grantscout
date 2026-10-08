import { collections } from '../../core/store.js';
import { recordRun } from '../../core/runs.js';
import { fetchGrants } from './client.js';

const BATCH_LIMIT = 450;

/**
 * Ingest GrantAtlas opportunities into the `grants` collection (idempotent
 * upsert by canonicalId) and record a syncLog. Grants are a separate entity
 * from organizations, so this runs outside the org sensor pipeline.
 */
export async function ingestGrants(opts: { runId?: string } = {}): Promise<{ grants: number }> {
  console.log('[grantatlas-grants] fetching opportunities');
  const grants = await fetchGrants();
  console.log(`[grantatlas-grants] fetched ${grants.length} opportunities`);

  if (collections.grants && grants.length > 0) {
    const now = new Date().toISOString();
    for (let i = 0; i < grants.length; i += BATCH_LIMIT) {
      const batch = collections.grants.firestore.batch();
      for (const g of grants.slice(i, i + BATCH_LIMIT)) {
        batch.set(collections.grants.doc(g.id), { ...g, ingestedAt: now }, { merge: true });
      }
      await batch.commit();
    }
  }

  {
    await recordRun(opts.runId, {
      sourceId: 'grantatlas-grants',
      service: 'grantatlas-grants',
      timestamp: new Date().toISOString(),
      grantsIngested: grants.length,
      status: 'success',
    });
  }

  return { grants: grants.length };
}
