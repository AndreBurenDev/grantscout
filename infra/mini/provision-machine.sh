#!/usr/bin/env bash
# infra/mini/provision-machine.sh — runs INSIDE the machine as root. Idempotent.
# Base only: packages, Node 20, the service user, the data/config directories and a build of the committed tree.
# The systemd unit, the paid-host block and the env file arrive with the local-runtime port.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y curl ca-certificates sudo nftables sqlite3 build-essential python3 dnsutils >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get -qq install -y nodejs >/dev/null
fi
id grantscout >/dev/null 2>&1 || useradd --system --home /var/lib/grantscout --shell /usr/sbin/nologin grantscout
install -d -o grantscout -g grantscout -m 0750 /var/lib/grantscout
install -d -o root -g root -m 0755 /etc/grantscout
chown -R grantscout:grantscout /opt/grantscout
cd /opt/grantscout
# -H: HOME=/var/lib/grantscout, so the npm cache lands where the service user looks.
GS() { sudo -H -u grantscout "$@"; }
# .npmrc sets omit=dev; the build needs tsc, so include dev dependencies explicitly.
GS npm ci --include=dev --no-audit --no-fund
GS npm run build
(cd console && GS npm ci --include=dev --no-audit --no-fund && GS npm run build)
