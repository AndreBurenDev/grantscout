// Run records (collection `syncLogs`, the Console's "pipeline runs"). A run started by the scheduler or the
// Console already has a record; the CLI has none, so the pipeline creates one when it finishes.
import { collections, type DocData } from './store.js';

export type RunStatus = 'queued' | 'running' | 'success' | 'error';

/** Create a run record up front and return its id. */
export async function openRun(sourceId: string, status: RunStatus, extra: DocData = {}): Promise<string> {
  const ref = await collections.syncLogs.add({
    sourceId,
    timestamp: new Date().toISOString(),
    status,
    orgsIngested: 0,
    signalsIngested: 0,
    ...extra,
  });
  return ref.id;
}

/** Write the outcome onto an existing run record, or add a new one when there is none. */
export async function recordRun(runId: string | undefined, data: DocData): Promise<string> {
  if (runId) {
    await collections.syncLogs.doc(runId).set(data, { merge: true });
    return runId;
  }
  return (await collections.syncLogs.add(data)).id;
}
