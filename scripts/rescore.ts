/**
 * Re-score all organizations in Firestore against the current ICP / model
 * without re-ingesting. Run after editing src/scoring/icp.ts.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=... GEMINI_API_KEY=... npx tsx scripts/rescore.ts
 */
import { collections } from '../src/core/store.js';
import { scoreAndPersist } from '../src/scoring/persist.js';
import type { Organization, Signal } from '../src/core/types.js';

async function main() {
  if (!collections.organizations) {
    console.error('[rescore] Firestore not configured');
    process.exit(1);
  }
  const [orgsSnap, sigSnap] = await Promise.all([
    collections.organizations.get(),
    collections.signals.get(),
  ]);
  const orgs = orgsSnap.docs.map((d: any) => d.data() as Organization);
  const signals = sigSnap.docs.map((d: any) => d.data() as Signal);
  console.log(`[rescore] ${orgs.length} orgs, ${signals.length} signals`);

  const res = await scoreAndPersist(orgs, signals);
  console.log(`[rescore] scored ${res.scored}, queued ${res.queuedForReview} for review`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[rescore] failed:', e);
  process.exit(1);
});
