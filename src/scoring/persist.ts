import type { Organization, Signal, AccountScore } from '../core/types.js';
import { computeAccountScore } from './accountScore.js';
import { computeICPCentroid, computeFitScore, embeddingModelVersion } from '../ai/llm.js';
import { ICP_SEED_MISSIONS } from './icp.js';
import { collections } from '../core/store.js';

const REVIEW_CONFIDENCE_THRESHOLD = 0.6;
const FIRESTORE_BATCH_LIMIT = 450; // one transaction per chunk

export interface ScoringResult {
  scored: number;
  queuedForReview: number;
}

interface ReviewItemDoc {
  orgId: string;
  title: string;
  priority: 'high' | 'medium';
  reason: string;
  submittedBy: string;
  status: 'pending';
  createdAt: string;
}

/** Pure: should this org be sent for human review? */
export function needsReview(org: Organization): boolean {
  return !org.optedOut && (org.confidence?.overall ?? 1) < REVIEW_CONFIDENCE_THRESHOLD;
}

/** Pure: review priority from extraction confidence. */
export function reviewPriorityFor(confidence: number): 'high' | 'medium' {
  return confidence < 0.4 ? 'high' : 'medium';
}

async function commitInChunks<T>(
  items: { id: string; data: T }[],
  coll: any,
): Promise<void> {
  for (let i = 0; i < items.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = coll.firestore.batch();
    for (const it of items.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
      batch.set(coll.doc(it.id), it.data, { merge: true });
    }
    await batch.commit();
  }
}

/**
 * Compute Account Scores for resolved orgs and persist them to `accountScores`.
 * Also enqueues low-confidence orgs into `reviewQueue` so they surface in the
 * admin console. Writes to the local store.
 */
export async function scoreAndPersist(
  orgs: Organization[],
  signals: Signal[],
  modelVersion?: string,
): Promise<ScoringResult> {
  if (!collections.accountScores || orgs.length === 0) {
    return { scored: 0, queuedForReview: 0 };
  }

  const centroid = await computeICPCentroid(ICP_SEED_MISSIONS);

  const signalsByOrg = new Map<string, Signal[]>();
  for (const s of signals) {
    const arr = signalsByOrg.get(s.orgId);
    if (arr) arr.push(s);
    else signalsByOrg.set(s.orgId, [s]);
  }

  const scoreDocs: { id: string; data: AccountScore }[] = [];
  const reviewDocs: { id: string; data: ReviewItemDoc }[] = [];

  for (const org of orgs) {
    const related = signalsByOrg.get(org.canonicalId) ?? [];
    const fit = org.mission ? await computeFitScore(org.mission, centroid) : 0.3;
    const score = computeAccountScore(org, related, fit, 0.8, modelVersion ?? embeddingModelVersion());
    scoreDocs.push({ id: org.canonicalId, data: score });

    if (needsReview(org)) {
      const confidence = org.confidence?.overall ?? 1;
      reviewDocs.push({
        id: `org-${org.canonicalId}`,
        data: {
          orgId: org.canonicalId,
          title: org.names[0] ?? org.canonicalId,
          priority: reviewPriorityFor(confidence),
          reason: `Low extraction confidence (${confidence.toFixed(2)}) — verify organization details`,
          submittedBy: 'pipeline',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      });
    }
  }

  await commitInChunks(scoreDocs, collections.accountScores);
  if (reviewDocs.length > 0 && collections.reviewQueue) {
    await commitInChunks(reviewDocs, collections.reviewQueue);
  }

  return { scored: scoreDocs.length, queuedForReview: reviewDocs.length };
}
