import { collections } from '../core/store.js';
import type { Organization } from '../core/types.js';

// Standalone tokens dropped before name comparison (legal forms, geo, articles).
const STOPWORDS = new Set([
  'stichting', 'vereniging', 'fonds', 'foundation', 'nederland', 'nederlandse',
  'afdeling', 'the', 'of', 'voor', 'van', 'het', 'de', 'en',
]);

/**
 * Aggressive name normalization for cross-source matching (more lenient than the
 * canonicalId hash, which keys ANBI on RSIN and GrantAtlas on raw name).
 * "Stichting Kinderpostzegels Nederland" -> "kinderpostzegels".
 */
export function nameKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD') // decompose accents; the next line strips the marks
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ')
    .trim();
}

export interface MissionIndexEntry {
  canonicalId: string;
  mission: string;
}

/** Build a nameKey -> {canonicalId, mission} index from orgs that have a mission. */
export function buildMissionIndex(
  orgs: { canonicalId: string; names: string[]; mission?: string }[],
): Map<string, MissionIndexEntry> {
  const index = new Map<string, MissionIndexEntry>();
  for (const o of orgs) {
    if (!o.mission) continue;
    const k = nameKey(o.names?.[0] || '');
    if (k && !index.has(k)) {
      index.set(k, { canonicalId: o.canonicalId, mission: o.mission });
    }
  }
  return index;
}

/** Pure: borrow a mission for each missionless org that matches the index by name. */
export function enrichAgainstIndex(
  orgs: Organization[],
  index: Map<string, MissionIndexEntry>,
): { orgs: Organization[]; enriched: number } {
  let enriched = 0;
  const out = orgs.map((o) => {
    if (o.mission) return o;
    const k = nameKey(o.names?.[0] || '');
    const match = k ? index.get(k) : undefined;
    if (match && match.canonicalId !== o.canonicalId) {
      enriched++;
      return { ...o, mission: match.mission, updatedAt: new Date().toISOString() };
    }
    return o;
  });
  return { orgs: out, enriched };
}

/**
 * Backfill missions onto missionless orgs (e.g. GrantAtlas awardees, which arrive
 * as name + grant only) by matching them by normalized name against organizations
 * that already have a mission (e.g. ANBI's Doelstelling). This lets the Fit score
 * be computed from real embeddings instead of the 0.3 no-mission fallback.
 *
 * Borrows the mission only; full entity dedup (merging the awardee and the ANBI
 * record into one canonical org) is a follow-up. Runs against the local store.
 */
export async function enrichMissions(
  orgs: Organization[],
): Promise<{ orgs: Organization[]; enriched: number }> {
  const missionless = orgs.filter((o) => !o.mission);
  if (missionless.length === 0 || !collections.organizations) {
    return { orgs, enriched: 0 };
  }

  // Index existing mission-bearing orgs from the store, plus any in this batch.
  const snap = await collections.organizations.get();
  const existing = snap.docs.map((d: any) => ({
    canonicalId: d.id,
    names: d.data().names || [],
    mission: d.data().mission,
  }));
  const index = buildMissionIndex([...existing, ...orgs]);

  return enrichAgainstIndex(orgs, index);
}
