#!/usr/bin/env bash
# infra/mini/provision-machine.sh — runs INSIDE the machine as root. Idempotent.
# Packages, Node 20, the service user, data/config directories, a build of the committed tree, the systemd unit
# and the paid-host block. It does not write /etc/grantscout/env and does not start the service.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
# build-essential + python3: better-sqlite3's native build; dnsutils: paid-deny resolves via `dig @1.1.1.1`.
apt-get -qq install -y curl ca-certificates sudo nftables sqlite3 build-essential python3 dnsutils >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get -qq install -y nodejs >/dev/null
fi
id grantscout >/dev/null 2>&1 || useradd --system --home /var/lib/grantscout --shell /usr/sbin/nologin grantscout
install -d -o grantscout -g grantscout -m 0750 /var/lib/grantscout /var/lib/grantscout/snapshots
install -d -o root -g root -m 0755 /etc/grantscout
chown -R grantscout:grantscout /opt/grantscout
cd /opt/grantscout
# -H: HOME=/var/lib/grantscout, so the npm cache lands where the service user looks.
GS() { sudo -H -u grantscout "$@"; }
# .npmrc sets omit=dev; the build needs tsc, so include dev dependencies explicitly.
GS npm ci --include=dev --no-audit --no-fund
GS npm run build
(cd console && GS npm ci --include=dev --no-audit --no-fund && GS npm run build)
install -m 0644 infra/mini/grantscout.service /etc/systemd/system/grantscout.service
install -m 0755 infra/mini/paid-deny.sh /usr/local/sbin/grantscout-paid-deny
install -m 0644 infra/mini/paid-deny.service /etc/systemd/system/grantscout-paid-deny.service
install -m 0644 infra/mini/paid-deny.timer /etc/systemd/system/grantscout-paid-deny.timer
systemctl daemon-reload
# The nft block must be in place at every boot (grantscout.service Wants= it), not only after the timer fires.
systemctl enable grantscout-paid-deny.service grantscout-paid-deny.timer >/dev/null
/usr/local/sbin/grantscout-paid-deny
