// Runtime configuration: environment → typed config. Everything runs on the Mac Mini; there is no cloud
// credential here. Defaults are safe for local development and tests (data under ./.data, mock embeddings).
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;

const num = (k: string, d: number): number => {
  const n = Number(env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const list = (k: string): string[] =>
  (env[k] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Tests never touch the working tree: under vitest the data directory is a per-process temp dir.
const dataDir = env.DATA_DIR || (env.VITEST ? join(tmpdir(), `grantscout-test-${process.pid}`) : '.data');

export const config = {
  dataDir,
  // Under vitest every test file gets its own in-memory database.
  dbPath: env.VITEST ? ':memory:' : `${dataDir}/scout.db`,
  snapshotsDir: `${dataDir}/snapshots`,

  // Local LLM (Ollama on the Mini host, reached through the host relay). Empty base URL = keyword mock.
  ollamaBaseUrl: (env.OLLAMA_BASE_URL || '').replace(/\/$/, ''),
  llmModel: env.LLM_MODEL || '',
  embedModel: env.EMBED_MODEL || '',
  llmTimeoutMs: num('LLM_TIMEOUT_MS', 120_000),

  // GrantAtlas read access (awardee lists + opportunities). Unset = committed sample files.
  grantatlasReadApiUrl: env.GRANTATLAS_READ_API_URL || '',
  grantatlasGrantsApiUrl: env.GRANTATLAS_GRANTS_API_URL || '',
  grantatlasApiKey: env.GRANTATLAS_API_KEY || '',

  hubspotAccessToken: env.HUBSPOT_ACCESS_TOKEN || '',
  hubspotSyncEnabled: env.HUBSPOT_SYNC_ENABLED === 'true',

  console: {
    port: num('CONSOLE_PORT', 3300),
    staticDir: env.CONSOLE_STATIC_DIR || 'console/dist',
    // Source IP(s) from which the Tailscale-User-Login header is trusted (the serve proxy).
    trustedProxyIps: list('TRUSTED_PROXY_IPS'),
    allowlist: list('CONSOLE_ALLOWLIST').map((s) => s.toLowerCase()),
    // Service key for GET /api/ops/health. Fail-closed when empty.
    opsKey: env.OPS_KEY || '',
    // Development only: act as this user without a tailnet proxy. Refused when NODE_ENV=production.
    devAuthEmail: env.NODE_ENV === 'production' ? '' : (env.DEV_AUTH_EMAIL || '').toLowerCase(),
  },

  // The API and Console run, but no scheduled or manual run starts (first boot, imports, incidents).
  schedulerPaused: env.SCHEDULER_PAUSED === 'true',
};

export type Config = typeof config;
