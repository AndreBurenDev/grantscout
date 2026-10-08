#!/usr/bin/env bash
# infra/mini/host/backup.sh — 04:45 nightly on the Mini HOST (the isolated machine cannot mount host volumes).
# Online SQLite .backup (as the grantscout user, never root) + snapshots/ -> one tar stream -> restic repo on the external drive.
# Secret: the restic password is read from a file by restic (RESTIC_PASSWORD_FILE); it is never echoed or put on a command line.
# macOS note: the drive is a removable volume. restic (and bash) need their own Full Disk Access grant when started by
# launchd; without it the job hangs silently on first access. Test under launchd, not only over SSH.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"   # launchd's PATH is minimal; orb and restic live in Homebrew's prefix
export RESTIC_REPOSITORY=/Volumes/Backup/grantscout/restic
export RESTIC_PASSWORD_FILE="$HOME/.config/grantscout/restic-pass"
M=grantscout
DATA=/var/lib/grantscout
LOCKDIR="$HOME/.config/grantscout/backup.lock"   # also read by laptop/pull-backup.sh so it never copies a half-written repo
LOGDIR="$HOME/Library/Logs/grantscout"; mkdir -p "$LOGDIR"

die() { echo "backup: $*" >&2; exit 1; }
notify() { osascript -e "display notification \"$1\" with title \"GrantScout backup\"" >/dev/null 2>&1 || true; }
GS() { orb -m "$M" -u root bash -c "$1" </dev/null; }   # run a shell snippet as root inside the machine (stdin closed)

LOCKED=0
cleanup() {
  rc=$?
  # Only the run that holds the lock owns backup.db (a skipped second run must not delete the first run's copy).
  if [ "$LOCKED" = 1 ]; then
    GS "sudo -H -u grantscout rm -f $DATA/backup.db" >/dev/null 2>&1 || true
    rm -rf "$LOCKDIR"
  fi
  if [ "$rc" -ne 0 ]; then notify "FAILED (exit $rc) - see $LOGDIR/backup.err"; fi
}
trap cleanup EXIT

command -v orb >/dev/null || die "orb not found on PATH"
command -v restic >/dev/null || die "restic not found on PATH (brew install restic)"
[ -r "$RESTIC_PASSWORD_FILE" ] || die "restic password file missing or unreadable: $RESTIC_PASSWORD_FILE"
[ "$(stat -f %Lp "$RESTIC_PASSWORD_FILE")" = 600 ] || die "restic password file must be mode 600: $RESTIC_PASSWORD_FILE"
[ -f "$RESTIC_REPOSITORY/config" ] || die "restic repo missing at $RESTIC_REPOSITORY (drive attached? 'restic init' done?)"

# One run at a time. The lock holds our PID so a stale lock (crash, power loss) is detected and replaced.
mkdir -p "$(dirname "$LOCKDIR")"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  if kill -0 "$(cat "$LOCKDIR/pid" 2>/dev/null)" 2>/dev/null; then
    echo "backup: another run is in progress (pid $(cat "$LOCKDIR/pid")); skipping" >&2
    exit 1
  fi
  rm -rf "$LOCKDIR"
  mkdir "$LOCKDIR" || die "cannot take lock $LOCKDIR"
fi
LOCKED=1
echo $$ > "$LOCKDIR/pid"

# 1. Consistent online copy of the live DB, written by the grantscout user (a root sqlite3 on the live DB can leave
#    root-owned -wal/-shm files and break the service). Then prove the copy is sound before it is archived.
GS "sudo -H -u grantscout test -f $DATA/scout.db" || die "no database at $DATA/scout.db yet (service never started?)"
GS "sudo -H -u grantscout rm -f $DATA/backup.db"
GS "sudo -H -u grantscout sqlite3 $DATA/scout.db \".backup $DATA/backup.db\""
check=$(GS "sudo -H -u grantscout sqlite3 -readonly $DATA/backup.db 'PRAGMA integrity_check'")
[ "$check" = ok ] || die "integrity_check on the DB copy failed: $check"

# 2. Stream DB copy + snapshots into restic as one tar. The snapshot is first tagged 'pending'; only a fully successful
#    pipeline promotes it to 'nightly', so a truncated stream can never become the "latest" backup.
set +e
OUT=$(orb -m "$M" -u root bash -c "tar --warning=no-file-changed --warning=no-file-removed -C $DATA -cf - backup.db snapshots" </dev/null \
  | restic backup --stdin --stdin-filename grantscout.tar --tag pending --json)
rc=$?
set -e
SNAP=$(printf '%s\n' "$OUT" | sed -n 's/.*"snapshot_id":"\([0-9a-f]*\)".*/\1/p' | tail -n 1)
if [ "$rc" -ne 0 ]; then
  if [ -n "$SNAP" ]; then restic forget "$SNAP" --quiet >&2 || echo "backup: could not forget bad snapshot $SNAP (left tagged 'pending')" >&2; fi
  die "tar | restic backup failed (exit $rc); no retention run, no snapshot promoted"
fi
[ -n "$SNAP" ] || die "restic did not report a snapshot id"
restic tag --set nightly "$SNAP" --quiet

# 3. Retention (nightly snapshots only), then a cheap structural check of the repo.
restic forget --tag nightly --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune --quiet
restic check --quiet

echo "backup ok $(date -Iseconds) snapshot=$SNAP"
