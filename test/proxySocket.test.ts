// Real listeners, no injected seams: the identity header must open the API on the proxy socket and nowhere else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireTailnetUser, type ApiEnv } from '../src/server/auth.js';
import { listenProxySocket } from '../src/server/proxySocket.js';

const dir = mkdtempSync(join(tmpdir(), 'gs-'));
const socketPath = join(dir, 'c.sock');
const LOGIN = { 'Tailscale-User-Login': 'andre@example.com' };

const app = new Hono<ApiEnv>();
app.use('/api/*', requireTailnetUser({ allowlist: ['andre@example.com'] }));
app.get('/api/me', (c) => c.json({ email: c.get('email') }));

let tcp: ServerType;
let proxy: ServerType;
let port = 0;

function get(target: { port: number } | { socketPath: string }, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ ...target, host: '127.0.0.1', path: '/api/me', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  // A leftover file from a crashed process must not block the listener.
  writeFileSync(socketPath, 'stale');
  tcp = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  port = (tcp.address() as AddressInfo).port;
  await new Promise<void>((r) => { proxy = listenProxySocket(app, socketPath, r); });
});

afterAll(() => {
  tcp.close();
  proxy.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('proxy socket', () => {
  it('a loopback TCP request with an allowlisted login is refused: the peer address proves nothing', async () => {
    expect(await get({ port }, LOGIN)).toBe(401);
  });

  it('the same login on the proxy socket is accepted', async () => {
    expect(await get({ socketPath }, LOGIN)).toBe(200);
  });

  it('the socket still applies the allowlist and still needs an identity', async () => {
    expect(await get({ socketPath }, { 'Tailscale-User-Login': 'eve@example.com' })).toBe(403);
    expect(await get({ socketPath }, {})).toBe(401);
  });

  it('only the owner can open the socket file', () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});
