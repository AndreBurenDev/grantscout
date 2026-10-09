// Console and ops authentication on the Mac Mini. Mirrors GrantAtlas (spec §4.4 there):
//  - humans: `tailscale serve` adds Tailscale-User-Login; the header is trusted ONLY when the TCP peer is the
//    serve proxy, and the login must be on the allowlist;
//  - the host's health pull: a shared key in X-API-Key;
//  - every mutating request must prove it comes from the Console itself (ambient auth needs a CSRF guard).
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getConnInfo } from '@hono/node-server/conninfo';

export type ApiEnv = { Variables: { email: string } };

/** Length-independent constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Service-to-service auth via `X-API-Key`. Fail-closed when no key is configured. */
export function requireServiceKey(expected: string): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const key = c.req.header('X-API-Key') ?? '';
    if (!key || !expected || !safeEqual(key, expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
}

export interface UserAuthDeps {
  trustedProxyIps: string[];
  allowlist: string[];
  /** Development only (never set in production): act as this user without a proxy. */
  devAuthEmail?: string;
  remoteAddress?: (c: Context) => string | undefined;
}

const defaultRemote = (c: Context): string | undefined => {
  try { return getConnInfo(c).remote.address; } catch { return undefined; }
};
const normalizeIp = (ip: string | undefined): string => (ip ?? '').replace(/^::ffff:/, '');

export function requireTailnetUser(deps: UserAuthDeps): MiddlewareHandler<ApiEnv> {
  const trusted = deps.trustedProxyIps.map(normalizeIp);
  const allow = new Set(deps.allowlist.map((s) => s.toLowerCase()));
  return createMiddleware<ApiEnv>(async (c, next) => {
    if (deps.devAuthEmail) {
      c.set('email', deps.devAuthEmail);
      return next();
    }
    const remote = normalizeIp((deps.remoteAddress ?? defaultRemote)(c));
    if (!remote || !trusted.includes(remote)) return c.json({ error: 'not via tailnet proxy' }, 401);
    const login = (c.req.header('Tailscale-User-Login') ?? '').trim().toLowerCase();
    if (!login) return c.json({ error: 'missing tailnet identity' }, 401);
    if (!allow.has(login)) return c.json({ error: 'not allowed' }, 403);
    c.set('email', login);
    await next();
  });
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestHost(c: Context): string {
  const fwd = c.req.header('X-Forwarded-Host')?.split(',')[0]?.trim();
  const host = fwd || c.req.header('Host')?.trim();
  if (host) return host.toLowerCase();
  try { return new URL(c.req.url).host.toLowerCase(); } catch { return ''; }
}

/**
 * CSRF guard. Mutating requests need Sec-Fetch-Site: same-origin (every current browser sends it) or, when it
 * is absent, an Origin that matches the request host; and the body must be application/json, which rules out
 * the "simple" cross-site form posts that need no CORS preflight.
 */
export function requireSameOriginJson(): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    if (SAFE.has(c.req.method)) return next();
    const site = c.req.header('Sec-Fetch-Site')?.trim().toLowerCase();
    if (site) {
      if (site !== 'same-origin') return c.json({ error: 'cross-site request refused' }, 403);
    } else {
      const origin = c.req.header('Origin');
      let originHost = '';
      try { originHost = origin ? new URL(origin).host.toLowerCase() : ''; } catch { originHost = ''; }
      if (!originHost || originHost !== requestHost(c)) return c.json({ error: 'cross-site request refused' }, 403);
    }
    const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return c.json({ error: 'content-type must be application/json' }, 415);
    return next();
  });
}
