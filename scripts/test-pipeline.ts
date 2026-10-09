/**
 * Full pipeline test: ANBI + GrantAtlas → Score → HubSpot (dry-run)
 * Run with: npx tsx scripts/test-pipeline.ts
 */
import { extractAnbi } from '../src/pipeline/extractors/anbi.js';
import { extractGrantAtlasAwardees } from '../src/pipeline/extractors/grantatlas.js';
import { normalizeOrg, normalizeSignal } from '../src/pipeline/normalizer.js';
import { computeAccountScore } from '../src/scoring/accountScore.js';
import { rankProspects, syncProspectsToHubSpot } from '../src/orchestrator/hubspot.js';
import { computeICPCentroid, computeFitScore } from '../src/ai/llm.js';
import { ICP_SEED_MISSIONS } from '../src/scoring/icp.js';

// Sample ANBI data
const anbiData = `RSIN_Nummer	Naam	Doelstelling	Status
816064877	Stichting Miljeudefensie	Bescherming van het milieu	Actief
517341022	Rode Kruis Afdeling Amsterdam	Hulpverlening aan kwetsbaren	Actief
855718281	Stichting Openbaar Belang	Maatschappelijke betrokkenheid	Actief`;

// Sample GrantAtlas data
const grantatlasData = JSON.stringify([
  {
    awardeeNameNormalized: 'Stichting Miljeudefensie',
    country: 'NL',
    funderId: 'funder-eco-001',
    grantId: 'grant-climate-2026',
    awardedAmount: 100000,
    awardedDate: '2026-01-10T00:00:00Z',
    status: 'awarded',
  },
  {
    awardeeNameNormalized: 'Rode Kruis Afdeling Amsterdam',
    country: 'NL',
    funderId: 'funder-health-002',
    grantId: 'grant-health-2026',
    awardedAmount: 75000,
    awardedDate: '2026-02-01T00:00:00Z',
    status: 'awarded',
  },
]);

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         GrantScout Phase 1 Full Pipeline Test             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // 1. Extract from both sources
  console.log('1️⃣  EXTRACTION');
  console.log('─'.repeat(60));

  const anbiResult = extractAnbi(anbiData, 'snapshot-anbi-001');
  console.log(`   ANBI: ${anbiResult.orgs.length} orgs, ${anbiResult.signals.length} signals`);

  const grantatlasResult = extractGrantAtlasAwardees(grantatlasData, 'snapshot-ga-001');
  console.log(`   GrantAtlas: ${grantatlasResult.orgs.length} orgs, ${grantatlasResult.signals.length} signals\n`);

  // 2. Normalize both sources
  console.log('2️⃣  NORMALIZATION');
  console.log('─'.repeat(60));

  const allOrgs = [...anbiResult.orgs, ...grantatlasResult.orgs];
  const normalizedOrgs = allOrgs
    .map(o => normalizeOrg(o))
    .filter(r => r.org !== null)
    .map(r => r.org!);

  const allSignals = [...anbiResult.signals, ...grantatlasResult.signals];
  const normalizedSignals = allSignals
    .map(s => normalizeSignal(s))
    .filter(r => r.signal !== null)
    .map(r => r.signal!);

  console.log(`   Normalized: ${normalizedOrgs.length} orgs, ${normalizedSignals.length} signals\n`);

  // 3. Compute scores
  console.log('3️⃣  ACCOUNT SCORING');
  console.log('─'.repeat(60));

  // Compute ICP centroid from GrantMaster customer missions (demo seeds)
  const icpCentroid = await computeICPCentroid(ICP_SEED_MISSIONS);

  const prospects = await Promise.all(normalizedOrgs.map(async org => {
    const relatedSignals = normalizedSignals.filter(s => s.orgId === org.canonicalId);

    // Compute real Fit score from mission embedding similarity
    const fit = org.mission ? await computeFitScore(org.mission, icpCentroid) : 0.3;

    const score = computeAccountScore(org, relatedSignals, fit, 0.8);
    return { org, score };
  }));

  // Show top 3
  const ranked = rankProspects(prospects, 3);
  for (const p of ranked) {
    console.log(`\n   📊 ${p.org.names[0]}`);
    console.log(`      Score: ${p.score.score}/100 [${p.score.tier.toUpperCase()}]`);
    console.log(`      Fit: ${p.score.fit.toFixed(2)} | Intent: ${p.score.intent.toFixed(2)} | Timing: ${p.score.timing.toFixed(2)}`);
    if (p.score.reasons.length > 0) {
      console.log(`      Why: ${p.score.reasons[0].detail}`);
    }
  }

  // 4. HubSpot sync (dry-run)
  console.log(`\n\n4️⃣  HUBSPOT SYNC (DRY-RUN)`);
  console.log('─'.repeat(60));

  const syncResult = await syncProspectsToHubSpot(ranked);
  console.log(`   Result: ${syncResult.synced} synced, ${syncResult.logged} logged\n`);

  // Summary
  console.log('═'.repeat(60));
  console.log(`✓ Pipeline complete`);
  console.log(`  • ${normalizedOrgs.length} organizations ingested`);
  console.log(`  • ${normalizedSignals.length} signals detected`);
  console.log(`  • ${prospects.length} prospects scored`);
  console.log(`  • Top ${Math.min(3, prospects.length)} ranked for HubSpot\n`);
}

main().catch(console.error);
