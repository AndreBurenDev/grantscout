// Single-process entrypoint on the Mac Mini: scheduler + admin API + built Console on one port.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from '../core/config.js';
import { closeStore } from '../core/store.js';
import { createApi } from '../server/api.js';
import { Scheduler } from './scheduler.js';
import { closeInterruptedRuns, executeRun, lastStarted, markStarted, scheduleEntries } from './runRegistry.js';
import { seedSources } from './sources.js';

const SHUTDOWN_WAIT_MS = 25_000;
const log = (o: Record<string, unknown>): void => console.log(JSON.stringify(o));

if (process.env.NODE_ENV === 'production') {
  if (config.console.trustedProxyIps.length === 0) throw new Error('TRUSTED_PROXY_IPS is required in production');
  if (config.console.allowlist.length === 0) throw new Error('CONSOLE_ALLOWLIST is required in production');
  if (!config.console.opsKey) throw new Error('OPS_KEY is required in production');
}
if (config.console.devAuthEmail) {
  console.warn(JSON.stringify({ event: 'dev_auth_enabled', note: 'DEV_AUTH_EMAIL is set: every request is that user. Development only.' }));
}

const sourcesSeeded = seedSources();
const runsClosed = closeInterruptedRuns();

const scheduler = new Scheduler({
  entries: scheduleEntries,
  lastStarted,
  markStarted,
  run: executeRun,
  paused: config.schedulerPaused,
});

const app = createApi({
  scheduler,
  opsKey: config.console.opsKey,
  auth: {
    trustedProxyIps: config.console.trustedProxyIps,
    allowlist: config.console.allowlist,
    devAuthEmail: config.console.devAuthEmail,
  },
});

const staticRoot = relative(process.cwd(), config.console.staticDir) || '.';
app.use('/*', serveStatic({ root: staticRoot }));
const indexHtml = (() => {
  try { return readFileSync(join(config.console.staticDir, 'index.html'), 'utf8'); } catch { return '<p>Console not built</p>'; }
})();
// SPA fallback for client routes only — unknown /api paths stay a JSON 404.
app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(indexHtml)));

// The scheduler starts only once the port is bound, so a listen failure never starts runs.
const server = serve({ fetch: app.fetch, port: config.console.port, hostname: '0.0.0.0' }, () => {
  log({
    event: 'grantscout_started', port: config.console.port, dataDir: config.dataDir,
    llmModel: config.llmModel || null, embedModel: config.embedModel || null,
    schedulerPaused: config.schedulerPaused, sourcesSeeded, runsClosed,
  });
  scheduler.start();
});
server.on('error', (e) => {
  console.error(JSON.stringify({ event: 'server_error', error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ event: 'shutdown_start', signal });
  server.close();
  scheduler.stop();
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (scheduler.status().running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  const idle = !scheduler.status().running;
  if (idle) closeStore();
  log({ event: 'shutdown_done', signal, idle });
  process.exit(idle ? 0 : 1);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
