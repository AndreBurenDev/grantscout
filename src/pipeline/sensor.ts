import type { Source } from '../core/types.js';
import { fetchHttp, storeSnapshot } from './providers/http.js';
import { extractAnbi } from './extractors/anbi.js';
import { normalizeOrg, normalizeSignal } from './normalizer.js';
import { resolveOrganizations, deduplicateSignals, writeOrganizationsAndSignals } from './resolver.js';
import { enrichMissions } from './enrich.js';
import { enrichFromAnbiRegistry } from './enrichAnbi.js';
import { scoreAndPersist } from '../scoring/persist.js';
import { recordRun } from '../core/runs.js';

/**
 * Run sensor for a source: fetch → capture → extract → normalize → resolve → store.
 * Each step is independently testable and composable.
 */
export async function runSensor(
  source: Source,
  opts: { runId?: string } = {},
): Promise<{ orgs: number; signals: number }> {
  console.log(`[sensor] Starting ${source.id}`);

  try {
    // 1. Fetch via provider
    let rawData: Buffer;

    if (source.provider === 'http') {
      const url = source.fetchConfig?.url as string | undefined;
      if (!url) throw new Error(`${source.id}: missing fetchConfig.url`);

      console.log(`[sensor] Fetching from ${url}`);
      rawData = await fetchHttp(url);
    } else if (source.provider === 'grantatlas') {
      const { fetchGrantAtlasAwardees } = await import('./providers/grantatlas.js');
      console.log(`[sensor] Fetching GrantAtlas awardees`);
      rawData = await fetchGrantAtlasAwardees(source);
    } else if (source.provider === 'firecrawl') {
      // TODO implement Firecrawl provider
      throw new Error(`${source.id}: provider ${source.provider} not yet implemented`);
    } else {
      throw new Error(`${source.id}: unknown provider ${source.provider}`);
    }

    // 2. Store immutable raw snapshot on local disk
    console.log(`[sensor] Storing ${rawData.length} bytes as a raw snapshot`);
    const snapshotId = await storeSnapshot(source.id, rawData);

    // 3. Extract based on method
    console.log(`[sensor] Extracting via ${source.extractionMethod}`);
    let orgsRaw: any[] = [];
    let signalsRaw: any[] = [];

    if (source.extractionMethod === 'deterministic') {
      if (source.id === 'anbi-nl') {
        const result = extractAnbi(rawData, snapshotId);
        orgsRaw = result.orgs;
        signalsRaw = result.signals;
      } else if (source.id === 'grantatlas-awardees') {
        const { extractGrantAtlasAwardees } = await import('./extractors/grantatlas.js');
        const result = extractGrantAtlasAwardees(rawData, snapshotId);
        orgsRaw = result.orgs;
        signalsRaw = result.signals;
      } else {
        throw new Error(`${source.id}: deterministic extraction not implemented`);
      }
    } else if (source.extractionMethod === 'llm') {
      if (source.id === 'hiring-nl') {
        // For hiring, rawData should be JSON array of job postings
        const { extractHiringSignals } = await import('./extractors/hiring.js');
        const jobPostings = JSON.parse(rawData.toString('utf-8'));
        const result = await extractHiringSignals(jobPostings, snapshotId);
        orgsRaw = result.orgs;
        signalsRaw = result.signals;
      } else {
        throw new Error(`${source.id}: LLM extraction not yet implemented`);
      }
    } else {
      throw new Error(`${source.id}: unknown extraction method ${source.extractionMethod}`);
    }

    console.log(`[sensor] Extracted ${orgsRaw.length} orgs, ${signalsRaw.length} signals`);

    // 4. Normalize + validate
    const normalizedOrgs = orgsRaw.map(o => {
      const { org, errors } = normalizeOrg(o);
      if (errors.length > 0) {
        console.warn(`[sensor] Normalization errors for org ${o.canonicalId}:`, errors);
      }
      return org;
    }).filter((o): o is typeof o & {} => o !== null);

    const normalizedSignals = signalsRaw.map(s => {
      const { signal, errors } = normalizeSignal(s);
      if (errors.length > 0) {
        console.warn(`[sensor] Normalization errors for signal ${s.id}:`, errors);
      }
      return signal;
    }).filter((s): s is typeof s & {} => s !== null);

    console.log(`[sensor] Normalized ${normalizedOrgs.length} orgs, ${normalizedSignals.length} signals`);

    // 5. Resolve / dedup
    const resolvedOrgs = await resolveOrganizations(normalizedOrgs);
    const deduplicatedSignals = await deduplicateSignals(normalizedSignals);

    console.log(`[sensor] Resolved to ${resolvedOrgs.size} unique orgs`);

    // 5b. Enrich missionless orgs (e.g. GrantAtlas awardees) so Fit can be
    // scored for real instead of the 0.3 fallback:
    //   1) borrow a mission from an already-known org (cheap), then
    //   2) look the org up in the live ANBI register and scrape its website's
    //      doelstelling for any still missing one.
    const borrow = await enrichMissions(Array.from(resolvedOrgs.values()));
    const anbi = await enrichFromAnbiRegistry(borrow.orgs);
    const orgsToWrite = anbi.orgs;
    const enriched = borrow.enriched + anbi.enriched;
    if (enriched > 0 || anbi.matched > 0) {
      console.log(
        `[sensor] Enriched ${enriched} missions (borrow ${borrow.enriched}, ANBI+web ${anbi.enriched}/${anbi.matched} matched)`,
      );
    }

    // 6. Write to the store
    const writeResult = await writeOrganizationsAndSignals(
      orgsToWrite,
      deduplicatedSignals
    );

    console.log(`[sensor] Wrote ${writeResult.orgsWritten} orgs, ${writeResult.signalsWritten} signals`);

    // 6b. Score + enqueue review (secondary — never fail ingest on a scoring error)
    let scoring = { scored: 0, queuedForReview: 0 };
    try {
      scoring = await scoreAndPersist(orgsToWrite, deduplicatedSignals);
      console.log(`[sensor] Scored ${scoring.scored} orgs, queued ${scoring.queuedForReview} for review`);
    } catch (e) {
      console.warn('[sensor] Scoring step failed (non-fatal):', e);
    }

    // 7. Store sync log
    await recordRun(opts.runId, {
      sourceId: source.id,
      timestamp: new Date().toISOString(),
      orgsIngested: writeResult.orgsWritten,
      signalsIngested: writeResult.signalsWritten,
      scored: scoring.scored,
      queuedForReview: scoring.queuedForReview,
      snapshotId,
      status: 'success',
    });

    return { orgs: writeResult.orgsWritten, signals: writeResult.signalsWritten };
  } catch (error) {
    console.error(`[sensor] Error in ${source.id}:`, error);

    await recordRun(opts.runId, {
      sourceId: source.id,
      timestamp: new Date().toISOString(),
      orgsIngested: 0,
      signalsIngested: 0,
      status: 'error',
      error: String(error),
    });

    throw error;
  }
}
