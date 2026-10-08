#!/usr/bin/env bash
# infra/mini/create-machine.sh — run ON THE MINI HOST. Creates the isolated OrbStack machine and provisions it.
# Mirrors grantatlas/infra/mini/create-machine.sh. Sized below GrantAtlas (4 CPU / 12G): GrantScout is a batch
# pipeline with no browser, and the four machines together must fit OrbStack's 28 GB.
set -euo pipefail
M=grantscout
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
orb create --isolated --isolate-network --cpus 2 --memory 4G ubuntu:noble "$M"
orb -m "$M" -u root mkdir -p /opt/grantscout
# Ship the repo in (no host mounts in an isolated machine). Committed HEAD only — commit first.
# Untracked files (.env, grantscout-key.json) are deliberately NOT shipped: no cloud credential enters the machine.
git -C "$REPO" archive --format=tar HEAD | orb -m "$M" -u root tar -x -C /opt/grantscout
orb -m "$M" -u root bash /opt/grantscout/infra/mini/provision-machine.sh </dev/null
echo "Machine ready. No service is installed: GrantScout has no local runtime yet (see infra/mini/README.md)."
