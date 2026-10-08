#!/usr/bin/env bash
# infra/mini/create-machine.sh — run ON THE MINI HOST. Creates the isolated OrbStack machine and provisions it.
# Mirrors grantatlas/infra/mini/create-machine.sh. Sized below GrantAtlas (4 CPU / 12G): GrantScout is a batch
# pipeline with no browser, and the four machines together must fit OrbStack's 28 GB.
set -euo pipefail
M=grantscout
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
orb create --isolated --isolate-network --cpus 2 --memory 4G ubuntu:noble "$M"
"$REPO/infra/mini/deploy.sh"
echo "Machine ready. Do NOT start the service yet. Next (infra/mini/README.md): write /etc/grantscout/env with"
echo "SCHEDULER_PAUSED=true (step 2), put the Console on the tailnet (step 3), then start it paused (step 4)."
