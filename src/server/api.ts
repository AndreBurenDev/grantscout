// Admin API for the Console. Every document is returned as `{ id, data }`, the shape the Console's converters
// were written against, so the screens did not change when Firestore went away.
import { Hono } from 'hono';
import { z } from 'zod';
import { collections, type Row } from '../core/store.js';
import { openRun } from '../core/runs.js';
import { requireSameOriginJson, requireServiceKey, requireTailnetUser, type ApiEnv, type UserAuthDeps } from './auth.js';
import { health } from '../runtime/health.js';
import { isKnownRunId } from '../runtime/runRegistry.js';
import { SPECIAL_RUNS, effectiveSource } from '../runtime/sources.js';
import { isValidCron } from '../runtime/schedule.js';
import type { Scheduler } from '../runtime/scheduler.js';

export interface ApiDeps {
  scheduler: Scheduler;
  auth: UserAuthDeps;
  opsKey: string;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const SourcePatch = z.object({ enabled: z.boolean() }).strict();
const SourceBody = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.string().trim().max(2).default(''),
  acquisitionTier: z.enum(['api', 'feed', 'scrape', 'internal']),
  extractionMethod: z.enum(['deterministic', 'llm']),
  provider: z.enum(['http', 'firecrawl', 'apify', 'grantatlas']),
  signalTypes: z.array(z.string().max(40)).max(20).default([]),
  schedule: z.string().trim().max(100).optional(),
  enabled: z.boolean(),
}).passthrough();
const SettingsBody = z.object({
  autoRunEnabled: z.boolean(),
  emailOnFailure: z.boolean(),
  debugLogging: z.boolean(),
  minRelevanceScore: z.number().min(0).max(100),
  minFitScore: z.number().min(0).max(100),
}).strict();
const Decision = z.object({ decision: z.enum(['approved', 'rejected']) }).strict();
const RunBody = z.object({ sourceId: z.string().regex(SOURCE_ID) }).strict();

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return null; }
  const v = schema.safeParse(raw);
  return v.success ? v.data : null;
}

export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // Service endpoint first: it is authenticated by key, not by tailnet identity.
  app.get('/api/ops/health', requireServiceKey(deps.opsKey), async (c) => c.json(await health(deps.scheduler)));

  const user = requireTailnetUser(deps.auth);
  const csrf = requireSameOriginJson();
  app.use('/api/*', async (c, next) => (c.req.path === '/api/ops/health' ? next() : user(c, next)));
  app.use('/api/*', async (c, next) => (c.req.path === '/api/ops/health' ? next() : csrf(c, next)));

  app.get('/api/me', (c) => c.json({ email: c.get('email') }));

  app.get('/api/overview', (c) =>
    c.json({
      totalRuns: collections.syncLogs.count(),
      activeSources: collections.sources.count(['enabled', true]),
      pendingReview: collections.reviewQueue.count(['status', 'pending']),
      organizations: collections.organizations.count(),
      recentRuns: collections.syncLogs.all({ orderBy: ['timestamp', 'desc'], limit: 5 }),
      queue: deps.scheduler.status(),
    }),
  );

  // ---- runs ----
  app.get('/api/runs', (c) => c.json(collections.syncLogs.all({ orderBy: ['timestamp', 'desc'], limit: 500 })));

  app.get('/api/runs/:id', (c) => {
    const data = collections.syncLogs.doc(c.req.param('id')).read();
    return data ? c.json({ id: c.req.param('id'), data }) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/runs', async (c) => {
    const b = await body(c, RunBody);
    if (!b) return c.json({ error: 'invalid body' }, 400);
    if (!isKnownRunId(b.sourceId)) return c.json({ error: 'unknown source' }, 404);
    const st = deps.scheduler.status();
    if (st.paused) return c.json({ error: 'scheduler is paused' }, 409);
    if (st.running === b.sourceId || st.queued.some((q) => q.id === b.sourceId)) {
      return c.json({ error: 'already queued or running' }, 409);
    }
    const runId = await openRun(b.sourceId, 'queued', { trigger: 'console', requestedBy: c.get('email') });
    const res = deps.scheduler.enqueueManual(b.sourceId, runId);
    if (!res.queued) {
      collections.syncLogs.doc(runId).write({ status: 'error', error: `not queued: ${res.reason}` }, true);
      return c.json({ error: `not queued: ${res.reason}` }, 409);
    }
    return c.json({ id: runId }, 202);
  });

  // ---- sources ----
  app.get('/api/sources', (c) => {
    const rows: Row[] = collections.sources.all();
    for (const s of SPECIAL_RUNS) {
      if (!rows.some((r) => r.id === s.id)) {
        rows.push({ id: s.id, data: { name: s.name, schedule: s.schedule, enabled: true, provider: 'grantatlas', acquisitionTier: 'internal', extractionMethod: 'deterministic', signalTypes: [], country: '', builtin: true } });
      }
    }
    return c.json(rows);
  });

  app.patch('/api/sources/:id', async (c) => {
    const id = c.req.param('id');
    const b = await body(c, SourcePatch);
    if (!b) return c.json({ error: 'invalid body' }, 400);
    const ref = collections.sources.doc(id);
    if (ref.read() === undefined) return c.json({ error: 'not found' }, 404);
    ref.write({ enabled: b.enabled, updatedBy: c.get('email'), updatedAt: new Date().toISOString() }, true);
    return c.json({ ok: true });
  });

  app.put('/api/sources/:id', async (c) => {
    const id = c.req.param('id');
    if (!SOURCE_ID.test(id)) return c.json({ error: 'invalid id' }, 400);
    if (SPECIAL_RUNS.some((s) => s.id === id)) return c.json({ error: 'built-in run, not editable' }, 409);
    const b = await body(c, SourceBody);
    if (!b) return c.json({ error: 'invalid body' }, 400);
    if (b.schedule && !isValidCron(b.schedule)) return c.json({ error: 'invalid cron schedule' }, 400);
    const { lastRunAt: _a, lastRunStatus: _s, id: _i, ...rest } = b as Record<string, unknown>;
    collections.sources.doc(id).write({ ...rest, updatedBy: c.get('email'), updatedAt: new Date().toISOString() }, true);
    return c.json({ ok: true, source: effectiveSource(id) });
  });

  // ---- organizations, scores, grants ----
  app.get('/api/organizations', (c) => c.json(collections.organizations.all()));

  app.get('/api/organizations/:id', (c) => {
    const id = c.req.param('id');
    const org = collections.organizations.doc(id).read();
    const score = collections.accountScores.doc(id).read();
    return c.json({
      org: org ? { id, data: org } : null,
      score: score ? { id, data: score } : null,
      signals: collections.signals.all({ where: ['orgId', id] }),
    });
  });

  app.get('/api/scores', (c) => {
    const names = new Map<string, string>();
    for (const r of collections.organizations.all()) names.set(r.id, (r.data.names?.[0] as string | undefined) ?? r.id);
    return c.json(
      collections.accountScores.all().map((r) => ({ ...r, orgName: names.get((r.data.orgId as string) ?? r.id) ?? r.id })),
    );
  });

  app.get('/api/grants', (c) => c.json(collections.grants.all()));

  // ---- review queue ----
  app.get('/api/review', (c) => c.json(collections.reviewQueue.all({ where: ['status', c.req.query('status') ?? 'pending'] })));

  app.post('/api/review/:id/decision', async (c) => {
    const b = await body(c, Decision);
    if (!b) return c.json({ error: 'invalid body' }, 400);
    const ref = collections.reviewQueue.doc(c.req.param('id'));
    if (ref.read() === undefined) return c.json({ error: 'not found' }, 404);
    ref.write({ status: b.decision, reviewedBy: c.get('email'), reviewedAt: new Date().toISOString() }, true);
    return c.json({ ok: true });
  });

  // ---- settings ----
  app.get('/api/settings', (c) => c.json({ data: collections.settings.doc('console').read() ?? null }));

  app.put('/api/settings', async (c) => {
    const b = await body(c, SettingsBody);
    if (!b) return c.json({ error: 'invalid body' }, 400);
    collections.settings.doc('console').write({ ...b, updatedAt: new Date().toISOString(), updatedBy: c.get('email') }, true);
    return c.json({ ok: true });
  });

  return app;
}
