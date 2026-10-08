import { describe, it, expect } from 'vitest'
import {
  tsToDate,
  toRun,
  toSettings,
  toOrganization,
  toAccountScore,
  toSource,
  toReviewItem,
  toSignalSummary,
} from './converters'
import { DEFAULT_SETTINGS } from './types'

describe('tsToDate', () => {
  it('returns undefined for null/undefined', () => {
    expect(tsToDate(null)).toBeUndefined()
    expect(tsToDate(undefined)).toBeUndefined()
  })

  it('converts an ISO string, the form the service writes', () => {
    expect(tsToDate('2026-01-15T10:00:00Z')?.toISOString()).toBe('2026-01-15T10:00:00.000Z')
  })

  it('converts a plain { seconds } object', () => {
    expect(tsToDate({ seconds: 1700000000, nanoseconds: 0 })?.getTime()).toBe(
      1700000000 * 1000,
    )
  })

  it('parses an ISO string (the shape the backend writes)', () => {
    expect(tsToDate('2026-02-23T09:55:00Z')?.toISOString()).toBe(
      '2026-02-23T09:55:00.000Z',
    )
  })

  it('passes through Date and epoch number', () => {
    const d = new Date()
    expect(tsToDate(d)).toBe(d)
    expect(tsToDate(0)?.getTime()).toBe(0)
  })

  it('returns undefined for unparseable strings', () => {
    expect(tsToDate('not-a-date')).toBeUndefined()
  })
})

describe('toRun', () => {
  it('maps a real syncLogs ingest document', () => {
    const run = toRun('abc', {
      sourceId: 'anbi-nl',
      timestamp: '2026-02-23T09:55:00Z',
      orgsIngested: 1234,
      signalsIngested: 5678,
      status: 'success',
    })
    expect(run).toMatchObject({
      id: 'abc',
      sourceId: 'anbi-nl',
      orgsIngested: 1234,
      status: 'success',
    })
    expect(run.timestamp.toISOString()).toBe('2026-02-23T09:55:00.000Z')
  })

  it('defaults a missing timestamp to epoch and missing status to success', () => {
    const run = toRun('x', {})
    expect(run.timestamp.getTime()).toBe(0)
    expect(run.status).toBe('success')
  })
})

describe('toSettings', () => {
  it('falls back to defaults when the doc is missing', () => {
    expect(toSettings(undefined)).toMatchObject(DEFAULT_SETTINGS)
  })

  it('merges partial settings over defaults', () => {
    const s = toSettings({ debugLogging: true, minFitScore: 80 })
    expect(s.debugLogging).toBe(true)
    expect(s.minFitScore).toBe(80)
    expect(s.autoRunEnabled).toBe(DEFAULT_SETTINGS.autoRunEnabled)
  })
})

describe('toOrganization', () => {
  it('maps a real organization doc and falls back canonicalId to the id', () => {
    const o = toOrganization('org-1', {
      names: ['Stichting Test'],
      type: 'ngo',
      country: 'NL',
      identifiers: { anbi: true },
      themes: ['poverty'],
    })
    expect(o.canonicalId).toBe('org-1')
    expect(o.names[0]).toBe('Stichting Test')
    expect(o.identifiers.anbi).toBe(true)
  })

  it('coerces a legacy single `name` field into names[]', () => {
    expect(toOrganization('x', { name: 'Solo' }).names).toEqual(['Solo'])
  })
})

describe('toAccountScore', () => {
  it('defaults tier and arrays when missing', () => {
    const s = toAccountScore('org-1', { score: 72, fit: 0.7 })
    expect(s).toMatchObject({ id: 'org-1', orgId: 'org-1', score: 72, tier: 'low' })
    expect(s.reasons).toEqual([])
    expect(s.contributingSignals).toEqual([])
  })
})

describe('toSource', () => {
  it('defaults enabled to false and name to the id', () => {
    const s = toSource('anbi-nl', { provider: 'http' })
    expect(s).toMatchObject({ id: 'anbi-nl', name: 'anbi-nl', enabled: false })
    expect(s.signalTypes).toEqual([])
  })
})

describe('toReviewItem', () => {
  it('defaults status to pending and priority to medium', () => {
    const r = toReviewItem('r1', { title: 'Check me' })
    expect(r).toMatchObject({ id: 'r1', title: 'Check me', status: 'pending', priority: 'medium' })
  })
})

describe('toSignalSummary', () => {
  it('reads sourceId from provenance', () => {
    const s = toSignalSummary('sig-1', {
      type: 'grant_awarded',
      strength: 0.8,
      occurredAt: '2026-03-01T00:00:00Z',
      provenance: { sourceId: 'grantatlas' },
    })
    expect(s).toMatchObject({ id: 'sig-1', type: 'grant_awarded', sourceId: 'grantatlas' })
    expect(s.occurredAt?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })
})
