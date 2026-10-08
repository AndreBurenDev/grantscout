#!/usr/bin/env bash
# infra/mini/paid-deny.sh — machine-level block of paid AI/scrape hosts. Re-run daily.
# Installed as /usr/local/sbin/grantscout-paid-deny; runs as root inside the machine. Same design as GrantAtlas.
set -euo pipefail
HOSTS="generativelanguage.googleapis.com aiplatform.googleapis.com api.firecrawl.dev api.apify.com api.openai.com api.anthropic.com"
# 1) DNS: pin to an unroutable address (belt).
# shellcheck disable=SC2086
for h in $HOSTS; do grep -q " $h\$" /etc/hosts || echo "0.0.0.0 $h" >> /etc/hosts; done
# 2) nftables: drop + log any IP these names resolve to (braces).
# Resolve via public DNS (dig @1.1.1.1), NOT getent: /etc/hosts already pins the names to 0.0.0.0.
all=""
# shellcheck disable=SC2086
for h in $HOSTS; do
  all+="$(dig +short @1.1.1.1 "$h" A 2>/dev/null || true)"$'\n'
  all+="$(dig +short @1.1.1.1 "$h" AAAA 2>/dev/null || true)"$'\n'
done
# Dedupe (hosts share Google IPs; a duplicate element makes nft reject the whole ruleset). CNAME lines are dropped by the regexes.
v4=(); v6=()
while read -r ip; do [ -n "$ip" ] && v4+=("$ip"); done < <(printf '%s\n' "$all" | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' | sort -u || true)
while read -r ip; do [ -n "$ip" ] && v6+=("$ip"); done < <(printf '%s\n' "$all" | grep -E '^[0-9a-f:]+:[0-9a-f:]*$' | sort -u || true)
v4_set=""; v6_set=""
[ "${#v4[@]}" -gt 0 ] && v4_set="elements = { $(IFS=,; echo "${v4[*]}") }"
[ "${#v6[@]}" -gt 0 ] && v6_set="elements = { $(IFS=,; echo "${v6[*]}") }"
# Atomic swap in ONE transaction: create-if-missing, delete, redefine. No gap, and a syntax error leaves the old ruleset intact.
nft -f - <<NFT
table inet grantscout
delete table inet grantscout
table inet grantscout {
  set paid_v4 { type ipv4_addr; ${v4_set} }
  set paid_v6 { type ipv6_addr; ${v6_set} }
  chain out {
    type filter hook output priority 0; policy accept;
    ip daddr @paid_v4 log prefix "GS-PAID-DENY " drop
    ip6 daddr @paid_v6 log prefix "GS-PAID-DENY " drop
  }
}
NFT
echo "paid-deny: ${#v4[@]} v4, ${#v6[@]} v6 addresses blocked"
