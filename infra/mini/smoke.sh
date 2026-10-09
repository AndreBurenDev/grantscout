#!/usr/bin/env bash
# infra/mini/smoke.sh — run ON THE MINI HOST after the service is up. Every line must print OK.
# Contacts (from inside the machine): the Ollama relay, the blocked paid hosts and the open web.
# shellcheck disable=SC2015,SC2016  # `cmd && ok || ko`: ok() never fails; single-quoted bash -c bodies expand inside the machine
set -uo pipefail
M=grantscout
PORT="${GS_PORT:-3300}"
TAILNET_IP="${TAILNET_IP:-100.65.195.102}"
fail=0
ok() { echo "OK   $1"; }
ko() { echo "FAIL $1"; fail=1; }
IN() { orb -m "$M" bash -c "$1" </dev/null; }

IN "systemctl is-active --quiet grantscout" && ok "service active" || ko "service not active"
IN "curl -sf -m 10 http://${TAILNET_IP}:11434/api/tags >/dev/null" && ok "machine -> Ollama relay" || ko "machine -> Ollama relay"

# Layer 1 (hosts-file pin): the names must not connect.
for h in generativelanguage.googleapis.com api.firecrawl.dev; do
  IN "curl -s -m 8 -o /dev/null https://$h/ ; test \$? -ne 0" && ok "paid host blocked ($h)" || ko "paid host reachable ($h)"
done
# Layer 2 (nft): bypass the hosts file with --resolve to the REAL address; the packet filter alone must stop it.
IN '
  ip=$(dig +short @1.1.1.1 api.firecrawl.dev A | grep -E "^[0-9]+(\.[0-9]+){3}$" | head -1)
  [ -n "$ip" ] || exit 2
  curl -s -m 6 -o /dev/null --resolve "api.firecrawl.dev:443:$ip" https://api.firecrawl.dev/ ; test $? -ne 0
' && ok "paid host blocked by nft (hosts file bypassed)" || ko "nft block failed or could not resolve (firecrawl)"

IN 'curl -sf -m 8 -o /dev/null https://www.belastingdienst.nl/' && ok "open web reachable" || ko "open web unreachable"
IN 'curl -s -m 3 -o /dev/null http://host.orb.internal:4820/ ; test $? -ne 0' && ok "host loopback (Companion) NOT reachable" || ko "Companion reachable from machine"

# Auth: without a tailnet identity the API must refuse; the Console shell itself is public static files.
code=$(IN "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/api/me")
[ "$code" = 401 ] && ok "API refuses a request without tailnet identity (401)" || ko "API answered $code without identity"
code=$(IN "curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Tailscale-User-Login: nobody@example.com' http://127.0.0.1:${PORT}/api/organizations")
[ "$code" = 403 ] && ok "API refuses a login that is not allowlisted (403)" || ko "API answered $code for a non-allowlisted login"
code=$(IN "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/api/ops/health")
[ "$code" = 401 ] && ok "health refuses a request without the ops key (401)" || ko "health answered $code without a key"

# Ops key is passed to curl as a header file (process substitution), never on a command line.
KEY=$(orb -m "$M" -u root grep '^OPS_KEY=' /etc/grantscout/env </dev/null | cut -d= -f2-)
HEALTH=""
if [ -n "$KEY" ]; then HEALTH=$(curl -sf -m 8 -H @<(printf 'X-API-Key: %s\n' "$KEY") "http://grantscout.orb.local:${PORT}/api/ops/health" || true); fi
unset KEY
[ -n "$HEALTH" ] && ok "ops health answers with the key" || ko "ops health"
printf '%s' "$HEALTH" | grep -q '"integrity":"ok"' && ok "database integrity ok" || ko "database integrity"

# As the service user, read-only: a root-run sqlite3 could create root-owned -wal/-shm files and break the service.
orb -m "$M" -u root sudo -H -u grantscout sqlite3 -readonly /var/lib/grantscout/scout.db 'PRAGMA journal_mode;' </dev/null | grep -q wal && ok "db in WAL" || ko "db not WAL"
perm=$(orb -m "$M" -u root stat -c '%a %U' /etc/grantscout/env </dev/null)
[ "$perm" = "600 root" ] && ok "env file is 600 root" || ko "env file is '$perm', expected '600 root'"
n=$(orb -m "$M" -u root bash -c 'ls /opt/grantscout/.env /opt/grantscout/*key*.json 2>/dev/null | wc -l' </dev/null)
[ "$n" = 0 ] && ok "no .env or key file in the machine" || ko "$n credential file(s) found in /opt/grantscout"

exit $fail
