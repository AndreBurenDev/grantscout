// The Console's trusted door. `tailscale serve` forwards to a unix socket instead of the TCP port, and the
// Tailscale-User-Login header is believed only on requests that arrived there. A TCP peer address cannot carry
// that trust: OrbStack forwards the machine's port to the Mac's localhost, and those requests reach the service
// as 127.0.0.1, exactly like the serve proxy did. The socket file is 0600, so only the service user and root
// (tailscaled) can connect to it.
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { chmodSync, rmSync } from 'node:fs';
import type { Context } from 'hono';

const MARK = 'viaProxySocket';

/** True only for a request that arrived on the proxy socket. The mark is set server-side, never from the request. */
export const arrivedViaProxySocket = (c: Context): boolean =>
  (c.env as Record<string, unknown> | undefined)?.[MARK] === true;

interface Fetchable {
  fetch: (request: Request, env?: Record<string, unknown>) => Response | Promise<Response>;
}

export function listenProxySocket(app: Fetchable, path: string, onListening: () => void): ServerType {
  // A socket file left by a crashed process would make listen() fail with EADDRINUSE.
  rmSync(path, { force: true });
  const server = createAdaptorServer({ fetch: (request, env) => app.fetch(request, { ...env, [MARK]: true }) });
  server.listen(path, () => {
    chmodSync(path, 0o600);
    onListening();
  });
  return server;
}
