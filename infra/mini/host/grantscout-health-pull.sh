#!/usr/bin/env bash
# infra/mini/host/grantscout-health-pull.sh — run ON THE MINI HOST by launchd, every 15 minutes.
# Pulls /api/ops/health, posts each problem to the CTO Companion as a follow-up, and notifies if the service is down.
# Secrets: the ops key and the Companion header are only ever read from files and handed to curl via `-H @file`;
# never echoed, logged, or put on a command line.
set -euo pipefail
OPS_KEY_FILE="$HOME/.config/grantscout/ops-key"
COMPANION_HEADER_FILE="$HOME/.config/cto-companion/auth-header"
HEALTH_URL="${GS_HEALTH_URL:-http://grantscout.orb.local:3300/api/ops/health}"
COMPANION_URL="${GS_COMPANION_URL:-http://localhost:4820/api/followups}"
LOGDIR="$HOME/Library/Logs/grantscout"; mkdir -p "$LOGDIR"
TODAY=$(date +%F)
notify() { osascript -e "display notification \"$1\" with title \"$2\"" >/dev/null 2>&1 || true; }

[ -r "$OPS_KEY_FILE" ] || { echo "$(date -u +%FT%TZ) ops-key file missing: $OPS_KEY_FILE" >> "$LOGDIR/health-pull.log"; notify "ops-key file missing" "GrantScout health pull"; exit 0; }
KEY=$(tr -d '\r\n' < "$OPS_KEY_FILE")

JSON=$(curl -sf -m 10 -H @<(printf 'X-API-Key: %s\n' "$KEY") "$HEALTH_URL") || {
  # Not answering: notify at most once an hour so a long outage does not spam every 15 minutes.
  if [ -z "$(find "$LOGDIR/down-notified" -mmin -60 2>/dev/null)" ]; then
    notify "GrantScout is not answering" "GrantScout DOWN"
    touch "$LOGDIR/down-notified"
  fi
  echo "$(date -u +%FT%TZ) health pull failed" >> "$LOGDIR/health-pull.log"
  exit 0
}
unset KEY
rm -f "$LOGDIR/down-notified"
printf '%s\n' "$JSON" > "$LOGDIR/health-$TODAY.json"
find "$LOGDIR" -name 'health-*.json' -mtime +14 -delete 2>/dev/null || true

# Problems -> Companion follow-ups. The title is stable per (problem, day), and the Companion de-duplicates,
# so posting every 15 minutes is safe.
if ! printf '%s' "$JSON" | TODAY="$TODAY" COMPANION_HEADER_FILE="$COMPANION_HEADER_FILE" COMPANION_URL="$COMPANION_URL" /usr/bin/python3 -c '
import json, os, subprocess, sys
s = json.load(sys.stdin)
failed = 0
for p in s.get("problems", []):
    body = json.dumps({"what": "GrantScout: %s (%s)" % (p, os.environ["TODAY"]), "committed_on": os.environ["TODAY"],
                       "who_waiting": "GrantScout", "notes": "auto: GrantScout health pull"})
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "10", "-w", "%{http_code}",
                        "-H", "@" + os.environ["COMPANION_HEADER_FILE"], "-X", "POST", os.environ["COMPANION_URL"],
                        "-H", "Content-Type: application/json", "-d", body], capture_output=True, text=True)
    if not r.stdout.startswith("2"):
        failed += 1
        print("companion post failed: http " + (r.stdout or "none") + " for: " + p, file=sys.stderr)
sys.exit(1 if failed else 0)
' 2>> "$LOGDIR/health-pull.log"; then
  # Companion down (000) or key old (401): tell André once a day; problems are still in the health JSON log.
  if [ ! -f "$LOGDIR/companion-notified-$TODAY" ]; then
    notify "Could not record problems in the Companion (down or 401?) - see health-pull.log" "GrantScout alerts"
    touch "$LOGDIR/companion-notified-$TODAY"
  fi
fi
