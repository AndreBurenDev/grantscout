# GrantScout on the Mac Mini — machine base

GrantScout gets its own **isolated OrbStack machine** (`grantscout`, Ubuntu noble, no host mounts, isolated network) on the
Mac Mini, next to `grantatlas`. This directory mirrors `grantatlas/infra/mini`.

**State (2026-10-08): base only.** The machine exists and the committed tree builds inside it. Nothing runs: GrantScout is
still the Cloud Run / Firestore design and has no local runtime. No `.env`, no service-account key and no other cloud
credential is in the machine, by design.

| File | Where | Purpose |
|---|---|---|
| `create-machine.sh` | HOST | create the machine (2 CPU / 4 GB), ship committed HEAD in, run `provision-machine.sh` |
| `provision-machine.sh` | MACHINE (root) | packages, Node 20, `grantscout` user, data/config dirs, build app + console |

Machine name `grantscout`, repo at `/opt/grantscout`, service user `grantscout`, data in `/var/lib/grantscout`,
config in `/etc/grantscout`. Re-run provisioning with
`orb -m grantscout -u root bash /opt/grantscout/infra/mini/provision-machine.sh </dev/null`.

## Still to come with the local-runtime port
Decided 2026-10-08: a full GrantAtlas-style port. Not built yet:
- local SQLite store replacing Firestore; Ollama via the host relay replacing the Gemini key
- `grantscout.service` (hardened systemd unit) and `/etc/grantscout/env`
- paid-host block (hosts pin + nftables), Console on the tailnet only
- `host/backup.sh` + plist: nightly restic to `/Volumes/Backup/grantscout/restic` on the external drive
  (the backup binary needs its own macOS removable-volume grant; test under launchd, not only over SSH)
- laptop pull, restore drill, smoke script
