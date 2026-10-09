import { describe, it, expect } from 'vitest';
import { dueEntries, isValidCron, lastTickAtOrBefore } from '../src/runtime/schedule.js';
import { Scheduler, type QueueItem } from '../src/runtime/scheduler.js';

const at = (iso: string) => new Date(iso);

describe('dueEntries', () => {
  const daily = { id: 'a', cron: '0 4 * * *', enabled: true };

  it('is due when it has never started', () => {
    expect(dueEntries([daily], {}, at('2026-10-08T10:00:00Z')).map((e) => e.id)).toEqual(['a']);
  });

  it('is not due again after it started for the latest tick', () => {
    // 04:00 Amsterdam on 8 Oct 2026 (CEST) is 02:00Z.
    expect(dueEntries([daily], { a: '2026-10-08T02:00:05Z' }, at('2026-10-08T10:00:00Z'))).toEqual([]);
  });

  it('catches up exactly once after downtime spanning several ticks', () => {
    const due = dueEntries([daily], { a: '2026-10-01T02:00:05Z' }, at('2026-10-08T10:00:00Z'));
    expect(due).toHaveLength(1);
  });

  it('skips disabled entries and entries with an invalid cron', () => {
    expect(dueEntries([{ ...daily, enabled: false }], {}, at('2026-10-08T10:00:00Z'))).toEqual([]);
    expect(dueEntries([{ ...daily, cron: 'not a cron' }], {}, at('2026-10-08T10:00:00Z'))).toEqual([]);
  });

  it('evaluates cron in Amsterdam time', () => {
    expect(lastTickAtOrBefore('0 4 * * *', at('2026-10-08T10:00:00Z'))?.toISOString()).toBe('2026-10-08T02:00:00.000Z');
    expect(lastTickAtOrBefore('0 4 * * *', at('2026-01-08T10:00:00Z'))?.toISOString()).toBe('2026-01-08T03:00:00.000Z');
  });

  it('validates cron expressions', () => {
    expect(isValidCron('0 3 * * 1')).toBe(true);
    expect(isValidCron('every day')).toBe(false);
  });
});

function harness(opts: { paused?: boolean } = {}) {
  const started: Record<string, string> = {};
  const ran: QueueItem[] = [];
  let release: (() => void) | null = null;
  let active = 0;
  let maxActive = 0;
  const s = new Scheduler({
    entries: () => [
      { id: 'a', cron: '0 4 * * *', enabled: true },
      { id: 'b', cron: '0 5 * * *', enabled: true },
    ],
    lastStarted: () => started,
    markStarted: (id, iso) => { started[id] = iso; },
    run: async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      ran.push(item);
      if (item.id === 'slow') await new Promise<void>((r) => { release = r; });
      active--;
      if (item.id === 'boom') throw new Error('boom');
    },
    paused: opts.paused,
    now: () => at('2026-10-08T10:00:00Z'),
  });
  return { s, started, ran, release: () => release?.(), maxActive: () => maxActive };
}

describe('Scheduler', () => {
  it('runs every due entry once and marks it started', async () => {
    const h = harness();
    h.s.tick();
    await h.s.drain();
    expect(h.ran.map((r) => r.id)).toEqual(['a', 'b']);
    h.s.tick();
    await h.s.drain();
    expect(h.ran).toHaveLength(2); // nothing is due a second time
    expect(Object.keys(h.started).sort()).toEqual(['a', 'b']);
  });

  it('never runs two things at once and refuses a duplicate of a queued or running id', async () => {
    const h = harness();
    expect(h.s.enqueueManual('slow', 'r1')).toEqual({ queued: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.s.status().running).toBe('slow');
    expect(h.s.enqueueManual('slow')).toEqual({ queued: false, reason: 'duplicate' });
    expect(h.s.enqueueManual('a')).toEqual({ queued: true });
    expect(h.s.enqueueManual('a')).toEqual({ queued: false, reason: 'duplicate' });
    expect(h.s.status().queued.map((q) => q.id)).toEqual(['a']);
    h.release();
    await new Promise((r) => setTimeout(r, 5));
    await h.s.drain();
    expect(h.ran.map((r) => r.id)).toEqual(['slow', 'a']);
    expect(h.ran[0].runId).toBe('r1');
    expect(h.maxActive()).toBe(1);
  });

  it('keeps going after a run throws', async () => {
    const h = harness();
    h.s.enqueueManual('boom');
    h.s.enqueueManual('a');
    await new Promise((r) => setTimeout(r, 5));
    await h.s.drain();
    expect(h.ran.map((r) => r.id)).toEqual(['boom', 'a']);
    expect(h.s.status().running).toBeNull();
  });

  it('when paused it schedules nothing and refuses manual runs', async () => {
    const h = harness({ paused: true });
    h.s.start();
    h.s.tick();
    await h.s.drain();
    expect(h.ran).toEqual([]);
    expect(h.s.enqueueManual('a')).toEqual({ queued: false, reason: 'paused' });
    expect(h.s.status().paused).toBe(true);
  });

  it('after stop it starts nothing new', async () => {
    const h = harness();
    h.s.stop();
    h.s.tick();
    await h.s.drain();
    expect(h.ran).toEqual([]);
    expect(h.s.enqueueManual('a')).toEqual({ queued: false, reason: 'stopping' });
  });
});
