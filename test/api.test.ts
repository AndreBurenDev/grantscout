import { describe, it, expect, beforeEach } from 'vitest';
import { createApi } from '../src/server/api.js';
import { collections, closeStore } from '../src/core/store.js';
import { Scheduler, type QueueItem } from '../src/runtime/scheduler.js';
import { seedSources, effectiveSource } from '../src/runtime/sources.js';
import { closeInterruptedRuns, executeRun, scheduleEntries } from '../src/runtime/runRegistry.js';

const PROXY = '127.0.0.1';
const USER = { 'Tailscale-User-Login': 'Andre@Example.com' };
const WRITE = { ...USER, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

function setup(opts: { paused?: boolean; remote?: string; allow?: string[]; devAuthEmail?: string } = {}) {
  const ran: QueueItem[] = [];
  const scheduler = new Scheduler({
    entries: () => [], lastStarted: () => ({}), markStarted: () => undefined,
    run: async (item) => { ran.push(item); },
    paused: opts.paused,
  });
  const app = createApi({
    scheduler,
    opsKey: 'ops-secret',
    auth: {
      trustedProxyIps: [PROXY],
      allowlist: opts.allow ?? ['andre@example.com'],
      devAuthEmail: opts.devAuthEmail,
      remoteAddress: () => opts.remote ?? PROXY,
    },
  });
  return { app, ran, scheduler };
}

beforeEach(() => { closeStore(); seedSources(); });

describe('authentication', () => {
  it('rejects a request that did not come through the trusted proxy, even with the identity header', async () => {
    const { app } = setup({ remote: '10.0.0.9' });
    expect((await app.request('/api/me', { headers: USER })).status).toBe(401);
  });

  it('rejects a missing identity and a login that is not on the allowlist', async () => {
    const { app } = setup();
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/me', { headers: { 'Tailscale-User-Login': 'eve@example.com' } })).status).toBe(403);
  });

  it('accepts an allowlisted login, case-insensitively', async () => {
    const { app } = setup();
    const res = await app.request('/api/me', { headers: USER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'andre@example.com' });
  });

  it('accepts an IPv4-mapped IPv6 proxy address', async () => {
    const { app } = setup({ remote: '::ffff:127.0.0.1' });
    expect((await app.request('/api/me', { headers: USER })).status).toBe(200);
  });

  it('an empty allowlist lets nobody in', async () => {
    const { app } = setup({ allow: [] });
    expect((await app.request('/api/me', { headers: USER })).status).toBe(403);
  });

  it('health needs the ops key and ignores tailnet identity', async () => {
    const { app } = setup({ remote: '10.0.0.9' });
    expect((await app.request('/api/ops/health')).status).toBe(401);
    expect((await app.request('/api/ops/health', { headers: { 'X-API-Key': 'wrong' } })).status).toBe(401);
    expect((await app.request('/api/ops/health', { headers: USER })).status).toBe(401);
    const ok = await app.request('/api/ops/health', { headers: { 'X-API-Key': 'ops-secret' } });
    expect(ok.status).toBe(200);
    const h = await ok.json();
    expect(h.ok).toBe(true);
    expect(h.db.integrity).toBe('ok');
    expect(h.sources.map((s: { id: string }) => s.id)).toContain('anbi-nl');
  });

  it('the ops key does not open the user API', async () => {
    const { app } = setup({ remote: '10.0.0.9' });
    expect((await app.request('/api/organizations', { headers: { 'X-API-Key': 'ops-secret' } })).status).toBe(401);
  });
});

describe('CSRF guard', () => {
  it('refuses a cross-site write and a non-JSON write', async () => {
    const { app } = setup();
    const cross = await app.request('/api/settings', { method: 'PUT', headers: { ...WRITE, 'sec-fetch-site': 'cross-site' }, body: '{}' });
    expect(cross.status).toBe(403);
    const form = await app.request('/api/settings', { method: 'PUT', headers: { ...WRITE, 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
  });

  it('without Sec-Fetch-Site it needs an Origin matching the host', async () => {
    const { app } = setup();
    const base = { ...USER, 'content-type': 'application/json', host: 'scout.example' };
    const body = JSON.stringify({ decision: 'approved' });
    expect((await app.request('/api/review/x/decision', { method: 'POST', headers: base, body })).status).toBe(403);
    expect((await app.request('/api/review/x/decision', { method: 'POST', headers: { ...base, origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await app.request('/api/review/x/decision', { method: 'POST', headers: { ...base, origin: 'https://scout.example' }, body })).status).toBe(404);
  });
});

describe('runs', () => {
  it('queues a manual run with a record the pipeline will finish', async () => {
    const { app, ran } = setup();
    const res = await app.request('/api/runs', { method: 'POST', headers: WRITE, body: JSON.stringify({ sourceId: 'anbi-nl' }) });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toEqual([{ id: 'anbi-nl', trigger: 'console', runId: id }]);
    const run = collections.syncLogs.doc(id).read();
    expect(run).toMatchObject({ sourceId: 'anbi-nl', status: 'queued', trigger: 'console', requestedBy: 'andre@example.com' });
  });

  it('refuses unknown sources, bad bodies, and everything while paused', async () => {
    const { app } = setup();
    expect((await app.request('/api/runs', { method: 'POST', headers: WRITE, body: JSON.stringify({ sourceId: 'nope' }) })).status).toBe(404);
    expect((await app.request('/api/runs', { method: 'POST', headers: WRITE, body: JSON.stringify({ sourceId: '../x' }) })).status).toBe(400);
    expect((await app.request('/api/runs', { method: 'POST', headers: WRITE, body: 'not json' })).status).toBe(400);
    const paused = setup({ paused: true });
    const res = await paused.app.request('/api/runs', { method: 'POST', headers: WRITE, body: JSON.stringify({ sourceId: 'anbi-nl' }) });
    expect(res.status).toBe(409);
    expect(collections.syncLogs.count()).toBe(0);
  });

  it('lists runs newest first and returns one by id', async () => {
    const { app } = setup();
    await collections.syncLogs.doc('old').set({ sourceId: 'a', timestamp: '2026-01-01T00:00:00Z', status: 'success' });
    await collections.syncLogs.doc('new').set({ sourceId: 'a', timestamp: '2026-02-01T00:00:00Z', status: 'error' });
    const list = await (await app.request('/api/runs', { headers: USER })).json();
    expect(list.map((r: { id: string }) => r.id)).toEqual(['new', 'old']);
    expect((await (await app.request('/api/runs/new', { headers: USER })).json()).data.status).toBe('error');
    expect((await app.request('/api/runs/missing', { headers: USER })).status).toBe(404);
  });
});

describe('sources', () => {
  it('lists seeded sources plus the built-in grants run', async () => {
    const { app } = setup();
    const rows = await (await app.request('/api/sources', { headers: USER })).json();
    const ids = rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['anbi-nl', 'grantatlas-awardees', 'hiring-nl', 'grantatlas-grants']));
  });

  it('toggles a source and the scheduler sees it', async () => {
    const { app } = setup();
    expect(scheduleEntries().find((e) => e.id === 'anbi-nl')?.enabled).toBe(true);
    const res = await app.request('/api/sources/anbi-nl', { method: 'PATCH', headers: WRITE, body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(200);
    expect(effectiveSource('anbi-nl')?.enabled).toBe(false);
    expect(scheduleEntries().find((e) => e.id === 'anbi-nl')?.enabled).toBe(false);
    expect((await app.request('/api/sources/nope', { method: 'PATCH', headers: WRITE, body: JSON.stringify({ enabled: true }) })).status).toBe(404);
    expect((await app.request('/api/sources/anbi-nl', { method: 'PATCH', headers: WRITE, body: JSON.stringify({ enabled: 'yes' }) })).status).toBe(400);
  });

  it('saves a source but refuses a bad schedule, a bad id and the built-in run', async () => {
    const { app } = setup();
    const src = { name: 'New', country: 'NL', acquisitionTier: 'feed', extractionMethod: 'deterministic', provider: 'http', signalTypes: [], schedule: '0 6 * * *', enabled: false };
    expect((await app.request('/api/sources/new-src', { method: 'PUT', headers: WRITE, body: JSON.stringify(src) })).status).toBe(200);
    expect(collections.sources.doc('new-src').read()).toMatchObject({ name: 'New', schedule: '0 6 * * *', updatedBy: 'andre@example.com' });
    expect((await app.request('/api/sources/new-src', { method: 'PUT', headers: WRITE, body: JSON.stringify({ ...src, schedule: 'hourly' }) })).status).toBe(400);
    expect((await app.request('/api/sources/Bad_ID', { method: 'PUT', headers: WRITE, body: JSON.stringify(src) })).status).toBe(400);
    expect((await app.request('/api/sources/grantatlas-grants', { method: 'PUT', headers: WRITE, body: JSON.stringify(src) })).status).toBe(409);
  });

  it('seeding never overwrites an operator edit', () => {
    collections.sources.doc('anbi-nl').write({ enabled: false, schedule: '0 1 * * *' }, true);
    expect(seedSources()).toBe(0);
    expect(effectiveSource('anbi-nl')).toMatchObject({ enabled: false, schedule: '0 1 * * *', provider: 'http' });
  });
});

describe('data screens', () => {
  it('serves overview counts, organisation detail and joined scores', async () => {
    const { app } = setup();
    await collections.organizations.doc('o1').set({ canonicalId: 'o1', names: ['Org One'], country: 'NL' });
    await collections.accountScores.doc('o1').set({ orgId: 'o1', score: 80, tier: 'hot' });
    await collections.signals.doc('s1').set({ id: 's1', orgId: 'o1', type: 'grant_awarded' });
    await collections.signals.doc('s2').set({ id: 's2', orgId: 'other', type: 'grant_awarded' });
    await collections.reviewQueue.doc('r1').set({ orgId: 'o1', status: 'pending' });

    const ov = await (await app.request('/api/overview', { headers: USER })).json();
    expect(ov).toMatchObject({ organizations: 1, pendingReview: 1, activeSources: 2, totalRuns: 0 });

    const detail = await (await app.request('/api/organizations/o1', { headers: USER })).json();
    expect(detail.org.data.names).toEqual(['Org One']);
    expect(detail.score.data.score).toBe(80);
    expect(detail.signals.map((s: { id: string }) => s.id)).toEqual(['s1']);

    const missing = await (await app.request('/api/organizations/zzz', { headers: USER })).json();
    expect(missing).toEqual({ org: null, score: null, signals: [] });

    const scores = await (await app.request('/api/scores', { headers: USER })).json();
    expect(scores[0]).toMatchObject({ id: 'o1', orgName: 'Org One' });
  });

  it('records a review decision with who and when', async () => {
    const { app } = setup();
    await collections.reviewQueue.doc('r1').set({ orgId: 'o1', status: 'pending' });
    const res = await app.request('/api/review/r1/decision', { method: 'POST', headers: WRITE, body: JSON.stringify({ decision: 'approved' }) });
    expect(res.status).toBe(200);
    expect(collections.reviewQueue.doc('r1').read()).toMatchObject({ status: 'approved', reviewedBy: 'andre@example.com' });
    expect(await (await app.request('/api/review', { headers: USER })).json()).toEqual([]);
    expect((await app.request('/api/review/r1/decision', { method: 'POST', headers: WRITE, body: JSON.stringify({ decision: 'maybe' }) })).status).toBe(400);
  });

  it('saves settings and rejects unknown or out-of-range fields', async () => {
    const { app } = setup();
    const good = { autoRunEnabled: false, emailOnFailure: true, debugLogging: false, minRelevanceScore: 60, minFitScore: 70 };
    expect((await (await app.request('/api/settings', { headers: USER })).json()).data).toBeNull();
    expect((await app.request('/api/settings', { method: 'PUT', headers: WRITE, body: JSON.stringify(good) })).status).toBe(200);
    expect((await (await app.request('/api/settings', { headers: USER })).json()).data).toMatchObject({ ...good, updatedBy: 'andre@example.com' });
    expect((await app.request('/api/settings', { method: 'PUT', headers: WRITE, body: JSON.stringify({ ...good, minFitScore: 500 }) })).status).toBe(400);
    expect((await app.request('/api/settings', { method: 'PUT', headers: WRITE, body: JSON.stringify({ ...good, admin: true }) })).status).toBe(400);
  });
});

describe('run execution', () => {
  it('runs the sample ANBI source end to end and records the outcome on the run and the source', async () => {
    const runRef = await collections.syncLogs.add({ sourceId: 'anbi-nl', status: 'queued', timestamp: new Date().toISOString() });
    await executeRun({ id: 'anbi-nl', trigger: 'console', runId: runRef.id });
    const run = runRef.read()!;
    expect(run.status).toBe('success');
    expect(run.orgsIngested).toBeGreaterThan(0);
    expect(run.finishedAt).toBeTruthy();
    expect(collections.syncLogs.count()).toBe(1); // the queued record was completed, not duplicated
    expect(collections.organizations.count()).toBe(run.orgsIngested);
    expect(collections.accountScores.count()).toBeGreaterThan(0);
    expect(collections.sources.doc('anbi-nl').read()).toMatchObject({ lastRunStatus: 'success' });
  });

  it('a failing run ends as error, never left running', async () => {
    collections.sources.doc('broken').write({ name: 'Broken', provider: 'http', extractionMethod: 'deterministic', enabled: true, fetchConfig: { url: 'file:///does/not/exist' } });
    await expect(executeRun({ id: 'broken', trigger: 'scheduler' })).rejects.toThrow();
    const runs = collections.syncLogs.all();
    expect(runs).toHaveLength(1);
    expect(runs[0].data.status).toBe('error');
    expect(collections.sources.doc('broken').read()).toMatchObject({ lastRunStatus: 'error' });
  });

  it('closes runs a previous process left open', async () => {
    await collections.syncLogs.doc('a').set({ status: 'running' });
    await collections.syncLogs.doc('b').set({ status: 'queued' });
    await collections.syncLogs.doc('c').set({ status: 'success' });
    expect(closeInterruptedRuns()).toBe(2);
    expect(collections.syncLogs.doc('a').read()).toMatchObject({ status: 'error', error: 'interrupted by a service restart' });
    expect(collections.syncLogs.doc('c').read()).toEqual({ status: 'success' });
  });
});
