// What a run id means and how to execute it, with one run record per execution.
import { collections } from '../core/store.js';
import { openRun, recordRun } from '../core/runs.js';
import { runSensor } from '../pipeline/sensor.js';
import { effectiveSource, noteSourceRun, SPECIAL_RUNS } from './sources.js';
import type { ScheduleEntry } from './schedule.js';
import type { QueueItem } from './scheduler.js';

export function isKnownRunId(id: string): boolean {
  return SPECIAL_RUNS.some((s) => s.id === id) || effectiveSource(id) !== undefined;
}

/** Everything the scheduler may start: enabled sources that have a schedule, plus the special runs. */
export function scheduleEntries(): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  for (const row of collections.sources.all()) {
    const s = effectiveSource(row.id);
    if (s?.schedule) entries.push({ id: s.id, cron: s.schedule, enabled: !!s.enabled });
  }
  for (const s of SPECIAL_RUNS) entries.push({ id: s.id, cron: s.schedule, enabled: true });
  return entries;
}

export function lastStarted(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of collections.scheduleState.all()) if (r.data.lastStartedAt) out[r.id] = r.data.lastStartedAt;
  return out;
}

export function markStarted(id: string, iso: string): void {
  collections.scheduleState.doc(id).write({ lastStartedAt: iso }, true);
}

/** Execute one queued run. Never leaves its record in 'queued' or 'running'. */
export async function executeRun(item: QueueItem): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = item.runId ?? (await openRun(item.id, 'running', { trigger: item.trigger }));
  await recordRun(runId, { status: 'running', startedAt, trigger: item.trigger });
  try {
    if (item.id === 'grantatlas-grants') {
      const { ingestGrants } = await import('../sources/grantatlas/ingest.js');
      await ingestGrants({ runId });
    } else {
      const source = effectiveSource(item.id);
      if (!source) throw new Error(`unknown source: ${item.id}`);
      await runSensor(source, { runId });
    }
    const finishedAt = new Date().toISOString();
    await recordRun(runId, { finishedAt });
    noteSourceRun(item.id, 'success', finishedAt);
  } catch (e) {
    const finishedAt = new Date().toISOString();
    await recordRun(runId, { status: 'error', error: e instanceof Error ? e.message : String(e), finishedAt });
    noteSourceRun(item.id, 'error', finishedAt);
    throw e;
  }
}

/** After a restart nothing is running: close records a previous process left open. */
export function closeInterruptedRuns(): number {
  let closed = 0;
  for (const status of ['running', 'queued'] as const) {
    for (const row of collections.syncLogs.all({ where: ['status', status] })) {
      collections.syncLogs.doc(row.id).write(
        { status: 'error', error: 'interrupted by a service restart', finishedAt: new Date().toISOString() },
        true,
      );
      closed++;
    }
  }
  return closed;
}
