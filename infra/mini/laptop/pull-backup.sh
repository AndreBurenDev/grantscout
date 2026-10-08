#!/usr/bin/env bash
# infra/mini/laptop/pull-backup.sh — on the LAPTOP; copies the restic repo from the Mini over the tailnet when it is reachable.
# The good copy ($DEST) is NEVER modified in place: we sync into $DEST.staging (hard-linking unchanged files from $DEST, so it
# costs little disk), verify it with restic, and only then swap it in. $DEST is never deleted before a verified replacement exists.
# Exit codes: quiet 0 when the Mini is unreachable or busy (retry next hour); 1 + stderr when something is wrong.
# Staleness: success stamps ~/Library/Logs/grantscout/last-good-pull; any non-success run notifies if that is older than 48 h.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
REMOTE_REPO=/Volumes/Backup/grantscout/restic
DEST="$HOME/Backups/grantscout-restic"
STAGING="$DEST.staging"
PREV="$DEST.prev"
PASSFILE="$HOME/.config/grantscout/restic-pass"
LOGDIR="$HOME/Library/Logs/grantscout"; mkdir -p "$LOGDIR"
STAMP="$LOGDIR/last-good-pull"
NOTIFIED="$LOGDIR/stale-notified"
STALE_MIN=$((48 * 60))

die() { echo "pull-backup: $*" >&2; exit 1; }
notify() { osascript -e "display notification \"$1\" with title \"GrantScout backup pull\"" >/dev/null 2>&1 || true; }

OK=0
on_exit() {
  [ "$OK" = 1 ] && return 0
  # Not a successful pull (unreachable, busy, or failed): alert once the last good pull is more than 48 h old.
  # Re-notify at most every 6 h; stay quiet while the copy is fresh.
  if [ -z "$(find "$STAMP" -mmin -"$STALE_MIN" 2>/dev/null)" ] && [ -z "$(find "$NOTIFIED" -mmin -360 2>/dev/null)" ]; then
    notify "GrantScout off-box backup is stale (no good pull for over 48 h)"
    touch "$NOTIFIED"
  fi
  return 0
}
trap on_exit EXIT

case "$DEST" in "$HOME"/?*) ;; *) die "DEST must be a path under \$HOME: $DEST" ;; esac
command -v restic >/dev/null || die "restic not found on PATH (brew install restic): refusing to pull without verifying the copy"
[ -r "$PASSFILE" ] || die "restic password file missing or unreadable: $PASSFILE"

# Recover from a crash between the two renames of a previous swap: the verified copy is still $DEST.prev.
if [ ! -d "$DEST" ] && [ -d "$PREV" ]; then mv "$PREV" "$DEST"; fi

ssh -o ConnectTimeout=5 -o BatchMode=yes mini true 2>/dev/null || exit 0

# Remote state helpers (single-quoted remote commands: $HOME / paths expand on the Mini).
backup_running() { ssh -o BatchMode=yes mini 'kill -0 "$(cat "$HOME/.config/grantscout/backup.lock/pid" 2>/dev/null)" 2>/dev/null'; }
# Names of snapshot/index files change whenever a backup, tag, or prune rewrites the repo.
fingerprint() { ssh -o BatchMode=yes mini "find '$REMOTE_REPO/snapshots' '$REMOTE_REPO/index' -type f | sort | cksum"; }

# Refuse to mirror from a missing/unmounted repo.
ssh -o BatchMode=yes mini "test -f '$REMOTE_REPO/config'" || die "remote repo $REMOTE_REPO/config not found on mini (volume unmounted?); local copy left untouched"
if backup_running; then echo "pull-backup: backup running on mini; will retry next interval"; exit 0; fi

before=$(fingerprint)
# --link-dest: unchanged packs are hard links into the current good copy (the laptop disk is nearly full). --delete only
# touches the staging dir, which this script owns and which starts as (or is re-synced to) a mirror of the remote.
LINK=()
[ -d "$DEST" ] && LINK=(--link-dest="$DEST")
rsync -a --delete ${LINK[@]+"${LINK[@]}"} "mini:$REMOTE_REPO/" "$STAGING/"

# The Mini must not have started or run a backup/prune while we copied (it could prune packs mid-copy).
if backup_running || [ "$(fingerprint)" != "$before" ]; then
  rm -rf "$STAGING"
  echo "pull-backup: repo changed on mini during the copy; staging discarded, will retry next interval"
  exit 0
fi

# Verify the staged copy BEFORE it can replace anything. --no-lock: do not write lock files into the copy.
if ! RESTIC_REPOSITORY="$STAGING" RESTIC_PASSWORD_FILE="$PASSFILE" restic check --no-lock --quiet >&2; then
  rm -rf "$STAGING"
  die "restic check failed on the staged copy (mini repo corrupt or copy damaged); good copy $DEST left untouched"
fi

# Swap: only now is the old copy demoted. Hard links mean .prev costs only the files that changed.
rm -rf "$PREV"
[ -d "$DEST" ] && mv "$DEST" "$PREV"
mv "$STAGING" "$DEST"
OK=1
date -Iseconds > "$STAMP"
rm -f "$NOTIFIED"
echo "pulled $(date -Iseconds)"
