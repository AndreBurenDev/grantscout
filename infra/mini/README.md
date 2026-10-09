# GrantScout on the Mac Mini — runbook

GrantScout runs in an **isolated OrbStack machine** (`grantscout`, Ubuntu noble, no host mounts, isolated network) on the
Mac Mini, next to `grantatlas`. One process (`node dist/runtime/main.js`) serves the scheduler, the admin API and the
built Console on port 3300. Data is one SQLite file plus raw snapshots on disk; AI is Ollama on the host. There is no
cloud runtime and no cloud credential in the machine. Everything marked **HOST** runs on the Mini (not inside the
machine); **MACHINE** runs inside it via `orb -m grantscout ...`.

| File | Where | Purpose |
|---|---|---|
| `create-machine.sh` | HOST | create the machine (2 CPU / 4 GB), then `deploy.sh` |
| `deploy.sh` | HOST | ship committed HEAD in, re-provision, restart the service if it was running |
| `provision-machine.sh` | MACHINE (root) | packages, Node 20, `grantscout` user, build, systemd unit, paid-API block |
| `grantscout.service` | MACHINE | the app (user `grantscout`, hardened) |
| `paid-deny.sh` / `.service` / `.timer` | MACHINE | paid AI/scrape hosts blocked at the network level (hosts-file pin + nftables), refreshed daily |
| `env.example` | MACHINE | `/etc/grantscout/env` template — exactly the variables `src/core/config.ts` reads |
| `smoke.sh` | HOST | end-to-end checks; every line must print `OK` |
| `host/backup.{sh,plist}` | HOST | 04:45 nightly: online SQLite `.backup` + `snapshots/` -> restic repo at `/Volumes/Backup/grantscout/restic` |
| `host/restore-drill.sh` | HOST | restore the latest backup into a throwaway `gs-restore` machine, compare counts, delete it |
| `host/grantscout-health-pull.{sh,plist}` | HOST | every 15 min pull `/api/ops/health` -> Companion follow-ups + macOS notifications |
| `laptop/pull-backup.{sh,plist}` | LAPTOP | hourly rsync of the restic repo over the tailnet (quiet no-op when the Mini is unreachable) |

Machine name `grantscout`, repo at `/opt/grantscout`, service user `grantscout`, data in `/var/lib/grantscout`
(`scout.db`, `snapshots/`), config in `/etc/grantscout/env`.

## Runbook (in order)

### 1. Create and provision the machine (HOST)
```bash
infra/mini/create-machine.sh
```
Ships **committed HEAD** (`git archive`), so commit or merge first. Untracked files (`.env`, key files) never enter the
machine. Later updates: `infra/mini/deploy.sh`.

### 2. Env file
Copy `env.example` to a local file (outside the repo), fill it in and keep **`SCHEDULER_PAUSED=true`**, then:
```bash
orb -m grantscout -u root sh -c 'umask 077; cat > /etc/grantscout/env' < local-env   # never world-readable, even briefly
orb -m grantscout -u root stat -c '%a %U' /etc/grantscout/env                          # expect: 600 root
```
`OPS_KEY`: `openssl rand -hex 32`. `OLLAMA_BASE_URL` is the Mini's tailnet IP on port 11434 (the host relay
`ai.grantmaster.ollama-tailnet` already serves it; GrantAtlas uses the same one). Delete the local file afterwards.

### 3. Console on the tailnet (Tailscale inside the machine)
The host's `tailscale serve` cannot reach OrbStack's isolated network, so, as for GrantAtlas, Tailscale runs inside
the machine. It forwards to the service's unix socket (`CONSOLE_PROXY_SOCKET`), not to port 3300:
```bash
orb -m grantscout -u root bash -c 'curl -fsSL https://tailscale.com/install.sh | sh && tailscale up --hostname=grantscout'
orb -m grantscout -u root tailscale serve --bg --https=443 unix:/run/grantscout/console.sock
```
`tailscale up` prints a login URL: open it and approve the node. Never enable Funnel. The Console is then at
`https://grantscout.<tailnet>.ts.net`. Only logins in `CONSOLE_ALLOWLIST` get in; everyone else sees "No access".

Why a socket: OrbStack forwards port 3300 to the Mac's localhost, and those requests reach the service as
`127.0.0.1`, the same address the serve proxy has. A peer address therefore cannot tell the proxy from any process
on the Mac sending its own `Tailscale-User-Login`. The socket file is `0600`: only the service user and root
(tailscaled) can connect. Never point `tailscale serve` at port 3300; the Console would answer 401 to everyone.

### 4. Start the service, paused (HOST)
```bash
orb -m grantscout -u root systemctl enable --now grantscout
orb -m grantscout -u root journalctl -u grantscout -n 20 --no-pager
```
Expect `grantscout_started` with `"schedulerPaused":true`. Nothing runs; a Console "Run" answers 409.
The CLI is not affected by the pause: `npm run pipeline:once -- --source anbi-nl` as the service user.

### 5. Smoke (HOST)
```bash
infra/mini/smoke.sh
```
Every line must print `OK` (exit 0).

### 6. Backups (HOST, then LAPTOP)
```bash
mkdir -p ~/.config/grantscout ~/Library/Logs/grantscout && chmod 700 ~/.config/grantscout
(umask 077; openssl rand -base64 32 > ~/.config/grantscout/restic-pass)       # keep an offline copy: without it the backups are unreadable
mkdir -p /Volumes/Backup/grantscout
RESTIC_PASSWORD_FILE=~/.config/grantscout/restic-pass restic init --repo /Volumes/Backup/grantscout/restic
bash infra/mini/host/backup.sh                                                 # -> backup ok <time> snapshot=<id>
cp infra/mini/host/backup.plist ~/Library/LaunchAgents/com.grantscout.backup.plist
launchctl load ~/Library/LaunchAgents/com.grantscout.backup.plist
launchctl kickstart gui/$(id -u)/com.grantscout.backup                         # must ALSO succeed under launchd
bash infra/mini/host/restore-drill.sh                                          # -> restore drill PASS
```
The external drive is a removable volume: macOS gives each program its own permission for it. A run that works over
SSH can still hang under launchd until `restic` has Full Disk Access (System Settings -> Privacy & Security). Always
confirm with the `kickstart` line and `tail ~/Library/Logs/grantscout/backup.log`.

Laptop pull (same pattern as GrantAtlas): copy `restic-pass` to the laptop (mode 600), `brew install restic`, copy
`laptop/pull-backup.sh` to `~/.local/share/grantscout/` and load the plist with its script path pointing there.

### 7. Health pull (HOST)
```bash
(umask 077; orb -m grantscout -u root grep '^OPS_KEY=' /etc/grantscout/env | cut -d= -f2- > ~/.config/grantscout/ops-key)
[ -s ~/.config/grantscout/ops-key ] || { echo 'ops-key is EMPTY: set OPS_KEY in /etc/grantscout/env first' >&2; false; }
cp infra/mini/host/grantscout-health-pull.plist ~/Library/LaunchAgents/com.grantscout.health-pull.plist
launchctl load ~/Library/LaunchAgents/com.grantscout.health-pull.plist
```

### 8. Unpause when ready (HOST)
```bash
orb -m grantscout -u root sed -i 's/^SCHEDULER_PAUSED=.*/SCHEDULER_PAUSED=false/' /etc/grantscout/env
orb -m grantscout -u root systemctl restart grantscout
```
With no schedule history every enabled source is due once, one after another (single worker). Unpause on a morning
you can watch. To stop everything again set `SCHEDULER_PAUSED=true` and restart (a run in progress finishes first).

## What still needs a decision or a credential
- **Embeddings.** Fit scoring uses real embeddings only when `EMBED_MODEL` names an Ollama embedding model that is
  pulled on the host. Until then it uses the keyword mock (`modelVersion: keyword-v1` on every score).
- **GrantAtlas data.** `GRANTATLAS_READ_API_URL` / `GRANTATLAS_GRANTS_API_URL` are unset, so the awardee and
  opportunity sources read the committed samples. GrantAtlas on the Mini has no key-authenticated read endpoint yet.
- **ANBI source.** `anbi-nl` still reads `data/anbi-sample.tsv` (see `src/sources/registry.ts`).
- **Old Firestore data.** See `infra/legacy-gcp/README.md` for the one-off export and
  `scripts/migrate/import-export.ts` for the import. The pipeline is idempotent, so re-ingesting is the alternative;
  only review decisions and Console settings exist nowhere else.
