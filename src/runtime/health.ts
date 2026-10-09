// Health summary for GET /api/ops/health (pulled by the host every 15 minutes).
import { collections, integrityCheck } from '../core/store.js';
import { config } from '../core/config.js';
import { ollamaReachable } from '../ai/llm.js';
import type { Scheduler } from './scheduler.js';

export interface HealthSummary {
  ok: boolean;
  time: string;
  problems: string[];
  scheduler: { paused: boolean; running: string | null; queued: string[] };
  db: { integrity: string };
  ollama: { configured: boolean; reachable: boolean | null; llmModel: string; embedModel: string };
  counts: { organizations: number; signals: number; accountScores: number; grants: number; pendingReview: number; runs: number };
  sources: { id: string; enabled: boolean; lastRunAt?: string; lastRunStatus?: string }[];
}

export async function health(scheduler: Scheduler): Promise<HealthSummary> {
  const problems: string[] = [];
  let integrity = 'unknown';
  try { integrity = integrityCheck(); } catch (e) { integrity = `error: ${(e as Error).message}`; }
  if (integrity !== 'ok') problems.push(`database integrity: ${integrity}`);

  const reachable = await ollamaReachable();
  if (reachable === false) problems.push('ollama unreachable');

  const sources = collections.sources.all().map((r) => ({
    id: r.id,
    enabled: !!r.data.enabled,
    lastRunAt: r.data.lastRunAt as string | undefined,
    lastRunStatus: r.data.lastRunStatus as string | undefined,
  }));
  for (const s of sources) if (s.enabled && s.lastRunStatus === 'error') problems.push(`source ${s.id}: last run failed`);

  const st = scheduler.status();
  return {
    ok: problems.length === 0,
    time: new Date().toISOString(),
    problems,
    scheduler: { paused: st.paused, running: st.running, queued: st.queued.map((q) => q.id) },
    db: { integrity },
    ollama: { configured: !!config.ollamaBaseUrl, reachable, llmModel: config.llmModel, embedModel: config.embedModel },
    counts: {
      organizations: collections.organizations.count(),
      signals: collections.signals.count(),
      accountScores: collections.accountScores.count(),
      grants: collections.grants.count(),
      pendingReview: collections.reviewQueue.count(['status', 'pending']),
      runs: collections.syncLogs.count(),
    },
    sources,
  };
}
