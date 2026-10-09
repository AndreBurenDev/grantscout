// Source configuration at runtime. The code registry (src/sources/registry.ts) defines what each source IS;
// the `sources` collection holds what an operator may change in the Console (enabled, schedule, name,
// fetchConfig) plus last-run facts. Missing sources are seeded from code on first boot.
import { SOURCES } from '../sources/registry.js';
import { collections, type DocData } from '../core/store.js';
import type { Source } from '../core/types.js';

/** Runs that are not org sensors but are scheduled and triggered the same way. */
export const SPECIAL_RUNS: { id: string; name: string; schedule: string }[] = [
  { id: 'grantatlas-grants', name: 'GrantAtlas opportunities catalog', schedule: '30 4 * * *' },
];

const OPERATOR_FIELDS = ['enabled', 'schedule', 'name', 'fetchConfig'] as const;

/** Insert code-defined sources that the store does not have yet. Never overwrites operator edits. */
export function seedSources(): number {
  let seeded = 0;
  for (const s of SOURCES) {
    const ref = collections.sources.doc(s.id);
    if (ref.read() === undefined) {
      const { id: _id, ...rest } = s;
      ref.write(rest as DocData);
      seeded++;
    }
  }
  return seeded;
}

/** The source as it should run now: code definition with the operator's stored overrides on top. */
export function effectiveSource(id: string): Source | undefined {
  const code = SOURCES.find((s) => s.id === id);
  const stored = collections.sources.doc(id).read();
  if (!code && !stored) return undefined;
  const merged: DocData = { ...(code ?? {}), id };
  if (stored) {
    if (!code) Object.assign(merged, stored);
    else for (const k of OPERATOR_FIELDS) if (stored[k] !== undefined) merged[k] = stored[k];
  }
  return merged as Source;
}

/** Record the outcome of the latest run on the source document (shown in the Console's Sources screen). */
export function noteSourceRun(id: string, status: 'success' | 'error', at: string): void {
  const ref = collections.sources.doc(id);
  if (ref.read() !== undefined) ref.write({ lastRunAt: at, lastRunStatus: status }, true);
}
