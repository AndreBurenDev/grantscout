import { describe, it, expect, beforeEach } from 'vitest';
import { collections, closeStore, deepMerge, integrityCheck } from '../src/core/store.js';
import { storeRawSnapshot, getRawSnapshot } from '../src/core/snapshots.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/core/config.js';

beforeEach(() => closeStore()); // in-memory database: closing it empties it

describe('document store', () => {
  it('writes, reads and reports missing documents', async () => {
    await collections.organizations.doc('a').set({ names: ['A'], country: 'NL' });
    const snap = await collections.organizations.doc('a').get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ names: ['A'], country: 'NL' });
    expect((await collections.organizations.doc('nope').get()).exists).toBe(false);
  });

  it('merge keeps other fields, merges maps and replaces arrays', async () => {
    const ref = collections.organizations.doc('a');
    await ref.set({ names: ['A', 'B'], identifiers: { rsin: '1' }, mission: 'm' });
    await ref.set({ names: ['C'], identifiers: { kvk: '2' } }, { merge: true });
    expect(ref.read()).toEqual({ names: ['C'], identifiers: { rsin: '1', kvk: '2' }, mission: 'm' });
  });

  it('set without merge replaces the document', async () => {
    const ref = collections.settings.doc('console');
    await ref.set({ a: 1, b: 2 });
    await ref.set({ a: 3 });
    expect(ref.read()).toEqual({ a: 3 });
  });

  it('drops undefined properties, as the Firestore client was configured to', async () => {
    await collections.signals.doc('s').set({ id: 's', payload: undefined, strength: 0.5 });
    expect(collections.signals.doc('s').read()).toEqual({ id: 's', strength: 0.5 });
  });

  it('add generates distinct ids', async () => {
    const a = await collections.syncLogs.add({ n: 1 });
    const b = await collections.syncLogs.add({ n: 2 });
    expect(a.id).not.toBe(b.id);
    expect(collections.syncLogs.count()).toBe(2);
  });

  it('a batch is atomic: a failing write rolls every write back', async () => {
    const batch = collections.organizations.firestore.batch();
    batch.set(collections.organizations.doc('ok'), { n: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular; // cannot be serialised → throws inside the transaction
    batch.set(collections.organizations.doc('bad'), circular);
    await expect(batch.commit()).rejects.toThrow();
    expect(collections.organizations.count()).toBe(0);
  });

  it('filters, orders, limits and counts', async () => {
    await collections.syncLogs.doc('1').set({ status: 'success', timestamp: '2026-01-01' });
    await collections.syncLogs.doc('2').set({ status: 'error', timestamp: '2026-01-03' });
    await collections.syncLogs.doc('3').set({ status: 'success', timestamp: '2026-01-02' });
    expect(collections.syncLogs.all({ orderBy: ['timestamp', 'desc'], limit: 2 }).map((r) => r.id)).toEqual(['2', '3']);
    expect(collections.syncLogs.all({ where: ['status', 'success'] }).map((r) => r.id).sort()).toEqual(['1', '3']);
    expect(collections.syncLogs.count(['status', 'error'])).toBe(1);
  });

  it('matches booleans stored as JSON true/false', async () => {
    await collections.sources.doc('on').set({ enabled: true });
    await collections.sources.doc('off').set({ enabled: false });
    expect(collections.sources.count(['enabled', true])).toBe(1);
    expect(collections.sources.all({ where: ['enabled', false] }).map((r) => r.id)).toEqual(['off']);
  });

  it('keeps collections apart', async () => {
    await collections.organizations.doc('x').set({ a: 1 });
    expect(collections.signals.doc('x').read()).toBeUndefined();
  });

  it('refuses field names that are not plain paths', () => {
    expect(() => collections.sources.all({ where: ["a') OR 1=1 --", 1] })).toThrow(/invalid field/);
  });

  it('passes the integrity check', () => {
    expect(integrityCheck()).toBe('ok');
  });
});

describe('deepMerge', () => {
  it('ignores undefined and does not mutate its inputs', () => {
    const base = { a: { b: 1 }, c: 2 };
    const out = deepMerge(base, { a: { d: 3 }, c: undefined });
    expect(out).toEqual({ a: { b: 1, d: 3 }, c: 2 });
    expect(base).toEqual({ a: { b: 1 }, c: 2 });
  });
});

describe('raw snapshots', () => {
  it('round-trips, is immutable and refuses to leave its directory', async () => {
    (config as { snapshotsDir: string }).snapshotsDir = mkdtempSync(join(tmpdir(), 'gs-snap-'));
    await storeRawSnapshot('raw/src/one.bin', Buffer.from('hello'));
    expect((await getRawSnapshot('raw/src/one.bin')).toString()).toBe('hello');
    await expect(storeRawSnapshot('raw/src/one.bin', 'again')).rejects.toThrow();
    await expect(storeRawSnapshot('../escape.bin', 'x')).rejects.toThrow(/invalid snapshot key/);
    await expect(getRawSnapshot('/etc/passwd')).rejects.toThrow(/invalid snapshot key/);
  });
});
