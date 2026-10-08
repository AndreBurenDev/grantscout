#!/usr/bin/env bash
# infra/mini/deploy.sh — run ON THE MINI HOST. Ships committed HEAD into the machine and (re)provisions it.
# Used for the first install and for every later update. The service is restarted only if it was running.
# Untracked files (.env, key files) are never shipped: `git archive` carries tracked files only.
set -euo pipefail
M=grantscout
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  echo "deploy: uncommitted changes in tracked files. Commit first: only committed HEAD is shipped." >&2
  exit 1
fi
was_active=$(orb -m "$M" -u root systemctl is-active grantscout 2>/dev/null </dev/null || true)
[ "$was_active" = active ] && orb -m "$M" -u root systemctl stop grantscout </dev/null
# Replace the code, keep nothing stale: data lives in /var/lib/grantscout and config in /etc/grantscout, not here.
orb -m "$M" -u root bash -c 'rm -rf /opt/grantscout && mkdir -p /opt/grantscout' </dev/null
git -C "$REPO" archive --format=tar HEAD | orb -m "$M" -u root tar -x -C /opt/grantscout
git -C "$REPO" rev-parse HEAD | orb -m "$M" -u root bash -c 'cat > /opt/grantscout/DEPLOYED_SHA'
orb -m "$M" -u root bash /opt/grantscout/infra/mini/provision-machine.sh </dev/null
if [ "$was_active" = active ]; then
  orb -m "$M" -u root systemctl start grantscout </dev/null
  echo "deploy: service restarted on $(git -C "$REPO" rev-parse --short HEAD)"
else
  echo "deploy: code updated to $(git -C "$REPO" rev-parse --short HEAD); service was not running and was left stopped"
fi
