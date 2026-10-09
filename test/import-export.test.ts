import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importExport, normalise } from '../scripts/migrate/import-export.js';
import { collections, closeStore } from '../src/core/store.js';

beforeEach(() => closeStore());

function exportDir(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-export-'));
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines.join('\n') + '\n');
  return dir;
}

describe('normalise', () => {
  it('turns Firestore timestamps into ISO strings at any depth and leaves other objects alone', () => {
    expect(normalise({ _seconds: 1767225600, _nanoseconds: 500_000_000 })).toBe('2026-01-01T00:00:00.500Z');
    expect(normalise({ seconds: 1767225600, nanoseconds: 0 })).toBe('2026-01-01T00:00:00.000Z');
    expect(normalise({ a: [{ at: { _seconds: 1767225600, _nanoseconds: 0 } }], seconds: 5, other: 1 }))
      .toEqual({ a: [{ at: '2026-01-01T00:00:00.000Z' }], seconds: 5, other: 1 });
  });
});

describe('importExport', () => {
  it('imports every known collection, is idempotent, and skips unknown files', async () => {
    const dir = exportDir({
      'organizations.jsonl': [
        JSON.stringify({ id: 'o1', data: { names: ['One'], createdAt: { _seconds: 1767225600, _nanoseconds: 0 } } }),
        JSON.stringify({ id: 'o2', data: { names: ['Two'] } }),
      ],
      'reviewQueue.jsonl': [JSON.stringify({ id: 'r1', data: { status: 'approved', reviewedBy: 'a@b.c' } })],
      'mystery.jsonl': [JSON.stringify({ id: 'x', data: {} })],
    });
    const first = await importExport(dir);
    expect(first).toEqual({ organizations: { read: 2, total: 2 }, reviewQueue: { read: 1, total: 1 } });
    expect(collections.organizations.doc('o1').read()).toEqual({ names: ['One'], createdAt: '2026-01-01T00:00:00.000Z' });
    expect(collections.reviewQueue.doc('r1').read()).toMatchObject({ status: 'approved' });
    const second = await importExport(dir);
    expect(second.organizations).toEqual({ read: 2, total: 2 });
  });

  it('stops on a malformed line and names it', async () => {
    const dir = exportDir({ 'signals.jsonl': [JSON.stringify({ id: 's1', data: {} }), '{"id": 5}'] });
    await expect(importExport(dir)).rejects.toThrow('signals.jsonl:2');
    await expect(importExport(exportDir({ 'signals.jsonl': ['not json'] }))).rejects.toThrow('signals.jsonl:1: not valid JSON');
  });

  it('refuses a missing or empty directory', async () => {
    await expect(importExport('/no/such/dir')).rejects.toThrow(/not found/);
    await expect(importExport(mkdtempSync(join(tmpdir(), 'gs-empty-')))).rejects.toThrow(/no \.jsonl/);
  });
});
