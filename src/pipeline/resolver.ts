import { collections } from '../core/store.js';
import type { Organization, Signal } from '../core/types.js';
import { organizationId } from '../core/ids.js';

/**
 * Entity resolution: dedup orgs, merge provenance, link to GrantAtlas.
 * Idempotent: same org (by RSIN/name+country) merges, old records yield.
 */
export async function resolveOrganizations(candidates: Organization[]): Promise<Map<string, Organization>> {
  const resolved = new Map<string, Organization>();

  // Group by RSIN (highest confidence), then by normalizedName + country
  const byRsin = new Map<string, Organization[]>();
  const byNameCountry = new Map<string, Organization[]>();

  for (const org of candidates) {
    if (org.identifiers?.rsin) {
      const group = byRsin.get(org.identifiers.rsin) ?? [];
      group.push(org);
      byRsin.set(org.identifiers.rsin, group);
    } else {
      const key = `${org.names[0]?.toLowerCase()}::${org.country}`;
      const group = byNameCountry.get(key) ?? [];
      group.push(org);
      byNameCountry.set(key, group);
    }
  }

  // Merge RSIN groups
  for (const [rsin, group] of byRsin.entries()) {
    if (group.length === 0) continue;

    const merged = mergeOrganizations(group);
    resolved.set(merged.canonicalId, merged);
  }

  // Merge name+country groups (skip if already resolved by RSIN)
  for (const [key, group] of byNameCountry.entries()) {
    const filtered = group.filter(
      org => !org.identifiers?.rsin || !byRsin.has(org.identifiers.rsin)
    );

    if (filtered.length === 0) continue;

    const merged = mergeOrganizations(filtered);
    resolved.set(merged.canonicalId, merged);
  }

  return resolved;
}

function mergeOrganizations(orgs: Organization[]): Organization {
  if (orgs.length === 0) throw new Error('Cannot merge empty list');
  if (orgs.length === 1) return orgs[0];

  const primary = orgs[0];
  const merged: Organization = {
    ...primary,
    names: Array.from(new Set(orgs.flatMap(o => o.names))),
    identifiers: {
      ...primary.identifiers,
      ...orgs.find(o => o.identifiers?.rsin)?.identifiers,
    },
    provenance: Array.from(
      new Map(orgs.flatMap(o => o.provenance).map(p => [p.sourceId, p])).values()
    ),
    mergedFrom: orgs.slice(1).map(o => o.canonicalId),
    updatedAt: new Date().toISOString(),
  };

  // Upgrade confidence if multiple sources agree
  if (merged.confidence.perField) {
    merged.confidence.overall = Math.min(
      1,
      merged.confidence.overall + (orgs.length > 1 ? 0.05 : 0)
    );
  }

  return merged;
}

export async function deduplicateSignals(signals: Signal[]): Promise<Signal[]> {
  const seen = new Set<string>();
  const deduped: Signal[] = [];

  for (const sig of signals) {
    if (!seen.has(sig.id)) {
      deduped.push(sig);
      seen.add(sig.id);
    }
  }

  return deduped;
}

/**
 * Write organizations and signals to the store.
 * Idempotent: same ID overwrites with merged provenance.
 */
export async function writeOrganizationsAndSignals(
  orgs: Organization[],
  signals: Signal[]
): Promise<{ orgsWritten: number; signalsWritten: number }> {
  const batch = collections.organizations.firestore.batch();

  for (const org of orgs) {
    batch.set(collections.organizations.doc(org.canonicalId), org, { merge: true });
  }

  for (const sig of signals) {
    batch.set(collections.signals.doc(sig.id), sig, { merge: true });
  }

  await batch.commit();
  return { orgsWritten: orgs.length, signalsWritten: signals.length };
}
