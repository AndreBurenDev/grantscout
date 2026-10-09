import { config } from '../core/config.js';
import { collections } from '../core/store.js';
import type { Organization, AccountScore } from '../core/types.js';

/**
 * HubSpot prospect representation.
 * Maps GrantScout org + score to HubSpot Company object.
 */
export interface HubSpotProspect {
  grantscout_id: string;   // stable upsert key (= org.canonicalId)
  name: string;
  country: string;
  grantscout_score: number;
  grantscout_tier: string;
  grantscout_fit: number;
  grantscout_intent: number;
  grantscout_timing: number;
  grantscout_reachability: number;
  grantscout_reasons: string;
  grantscout_source_rsin?: string;
  grantscout_updated_at: string;
}

/**
 * Convert GrantScout org + score to HubSpot prospect payload.
 */
export function toHubSpotProspect(org: Organization, score: AccountScore): HubSpotProspect {
  const reasonsText = score.reasons.map(r => `${r.factor}: ${r.detail}`).join('; ');

  return {
    grantscout_id: org.canonicalId,
    name: org.names[0] || 'Unknown',
    country: org.country,
    grantscout_score: score.score,
    grantscout_tier: score.tier,
    grantscout_fit: parseFloat(score.fit.toFixed(2)),
    grantscout_intent: parseFloat(score.intent.toFixed(2)),
    grantscout_timing: parseFloat(score.timing.toFixed(2)),
    grantscout_reachability: parseFloat(score.reachability.toFixed(2)),
    grantscout_reasons: reasonsText,
    grantscout_source_rsin: org.identifiers.rsin,
    grantscout_updated_at: new Date().toISOString(),
  };
}

/**
 * Sync prospects to HubSpot.
 * Dry-run by default (HUBSPOT_SYNC_ENABLED=false); logs payloads for review.
 */
export async function syncProspectsToHubSpot(
  prospects: { org: Organization; score: AccountScore }[]
): Promise<{ synced: number; logged: number }> {
  if (!config.hubspotAccessToken) {
    console.warn('[hubspot] No HUBSPOT_ACCESS_TOKEN configured, skipping sync');
    return { synced: 0, logged: prospects.length };
  }

  const hupsotPayloads = prospects.map(p => toHubSpotProspect(p.org, p.score));

  console.log(`\n[hubspot] Syncing ${hupsotPayloads.length} prospects`);
  console.log('[hubspot] Sample payload:', JSON.stringify(hupsotPayloads[0], null, 2));

  if (!config.hubspotSyncEnabled) {
    console.log('[hubspot] DRY-RUN MODE: No actual sync performed');
    console.log('[hubspot] To enable real sync, set HUBSPOT_SYNC_ENABLED=true');

    // Log the dry-run to the store for auditing
    if (collections.syncLogs) {
      try {
        await collections.syncLogs.add({
          service: 'hubspot',
          timestamp: new Date().toISOString(),
          prospectsCount: hupsotPayloads.length,
          status: 'dry-run',
          payloadSample: hupsotPayloads.slice(0, 3),
        });
      } catch (e) {
        console.warn('[hubspot] Could not log the dry-run:', e);
      }
    }

    return { synced: 0, logged: hupsotPayloads.length };
  }

  // Real sync: idempotent batch upsert into HubSpot Companies.
  try {
    const synced = await upsertCompanies(hupsotPayloads);
    console.log(`[hubspot] Synced ${synced} companies`);
    if (collections.syncLogs) {
      await collections.syncLogs.add({
        service: 'hubspot',
        timestamp: new Date().toISOString(),
        prospectsCount: hupsotPayloads.length,
        synced,
        status: 'success',
      });
    }
    return { synced, logged: hupsotPayloads.length };
  } catch (e) {
    console.error('[hubspot] Sync failed:', e);
    if (collections.syncLogs) {
      await collections.syncLogs.add({
        service: 'hubspot',
        timestamp: new Date().toISOString(),
        prospectsCount: hupsotPayloads.length,
        synced: 0,
        status: 'error',
        error: String(e),
      });
    }
    throw e;
  }
}

const HUBSPOT_API = 'https://api.hubapi.com';
const UPSERT_BATCH_SIZE = 100; // HubSpot batch limit

/**
 * Idempotently upsert companies into HubSpot via the CRM v3 batch upsert API,
 * matching on the custom unique property `grantscout_id`.
 *
 * Portal prerequisite: create the `grantscout_*` company properties, and mark
 * `grantscout_id` as a *unique* identifier so re-runs update rather than
 * duplicate. Returns the number of companies upserted.
 */
export async function upsertCompanies(payloads: HubSpotProspect[]): Promise<number> {
  let synced = 0;

  for (let i = 0; i < payloads.length; i += UPSERT_BATCH_SIZE) {
    const chunk = payloads.slice(i, i + UPSERT_BATCH_SIZE);
    const inputs = chunk.map((p) => ({
      idProperty: 'grantscout_id',
      id: p.grantscout_id,
      properties: p as unknown as Record<string, string | number>,
    }));

    const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/companies/batch/upsert`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.hubspotAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot upsert ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as { results?: unknown[] };
    synced += json.results?.length ?? chunk.length;
  }

  return synced;
}

/**
 * Rank prospects by Account Score tier and score value.
 * Returns top-N prospects ready for sync.
 */
export function rankProspects(
  prospects: { org: Organization; score: AccountScore }[],
  topN: number = 100
): { org: Organization; score: AccountScore }[] {
  const tierOrder = { hot: 0, warm: 1, cold_fit: 2, low: 3 };

  return prospects
    .sort((a, b) => {
      const tierDiff = tierOrder[a.score.tier] - tierOrder[b.score.tier];
      if (tierDiff !== 0) return tierDiff;
      return b.score.score - a.score.score; // higher score first
    })
    .slice(0, topN);
}
