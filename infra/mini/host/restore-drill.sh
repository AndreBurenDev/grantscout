#!/usr/bin/env bash
# infra/mini/host/restore-drill.sh — restore the latest nightly backup into a throwaway machine and compare counts.
# Run ON THE MINI. By default it reads the repo on the external drive; set GS_DRILL_REPO to test another copy
# (for example the laptop's, copied back: rsync -a laptop:Backups/grantscout-restic/ /tmp/gs-restic/).
# Safety: only the throwaway machine gs-restore is created/deleted. The real `grantscout` machine is touched READ-ONLY
# (sqlite3 -readonly as the grantscout user, count queries only). gs-restore is removed on exit, even on failure.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export RESTIC_REPOSITORY="${GS_DRILL_REPO:-/Volumes/Backup/grantscout/restic}"
export RESTIC_PASSWORD_FILE="$HOME/.config/grantscout/restic-pass"
LIVE=grantscout
D=gs-restore
DB=/var/lib/grantscout/scout.db

die() { echo "restore-drill: $*" >&2; exit 1; }
[ "$D" != "$LIVE" ] || die "refusing: throwaway machine name equals the live machine"
command -v orb >/dev/null || die "orb not found on PATH"
command -v restic >/dev/null || die "restic not found on PATH"
[ -r "$RESTIC_PASSWORD_FILE" ] || die "restic password file missing or unreadable: $RESTIC_PASSWORD_FILE"
[ -f "$RESTIC_REPOSITORY/config" ] || die "no restic repo at $RESTIC_REPOSITORY"

cleanup() { orb delete -f "$D" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup   # a leftover gs-restore from a crashed earlier drill is ours too; the name is reserved for this script

orb create --isolated --isolate-network ubuntu:noble "$D"
orb -m "$D" -u root bash -c 'apt-get -qq update && apt-get -qq install -y sqlite3 >/dev/null && mkdir -p /restore' </dev/null
# Only 'nightly' snapshots: a half-written 'pending' one (backup.sh) is never restorable material.
restic dump --tag nightly latest grantscout.tar | orb -m "$D" -u root tar -x -C /restore

fail=0
integ=$(orb -m "$D" -u root sqlite3 /restore/backup.db 'PRAGMA integrity_check' </dev/null)
echo "restored integrity_check=$integ"; [ "$integ" = ok ] || fail=1
for c in organizations signals accountScores grants syncLogs reviewQueue sources; do
  q="SELECT COUNT(*) FROM docs WHERE collection='$c'"
  live=$(orb -m "$LIVE" -u root bash -c "sudo -H -u grantscout sqlite3 -readonly $DB \"$q\"" </dev/null)
  rest=$(orb -m "$D" -u root sqlite3 /restore/backup.db "$q" </dev/null)
  note=""
  if [ "$rest" -gt "$live" ]; then note=" FAIL (restored > live)"; fail=1
  elif [ "$rest" -lt "$live" ]; then note=" (behind by $((live - rest)): writes since the last backup?)"; fi
  echo "$c live=$live restored=$rest$note"
done
orb -m "$D" -u root test -d /restore/snapshots </dev/null || { echo "FAIL: snapshots directory not restored" >&2; fail=1; }
files=$(orb -m "$D" -u root bash -c 'find /restore/snapshots -type f | wc -l' </dev/null)
echo "snapshot files restored=$files"

if [ "$fail" = 0 ]; then echo "restore drill PASS"; else echo "restore drill FAIL" >&2; exit 1; fi
