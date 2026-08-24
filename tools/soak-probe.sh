#!/usr/bin/env bash
# Soak probe — appends one line per run to /tmp/soak/probe.log.
#
# Two of PHASES.md's MVP criteria ("runs unattended for a week", "reconnects
# cleanly after sleep") have never been tested, and the failures they'd catch
# are the ones a fast test cannot: memory growth, socket churn, a lease left
# stale after a real laptop sleep, an event log that grows without bound.
#
# Run it from cron/launchd, or in a loop:
#   while :; do tools/soak-probe.sh; sleep 300; done
set -uo pipefail

DB="${DB:-apps/server/data.db}"
OUT="${OUT:-/tmp/soak/probe.log}"
mkdir -p "$(dirname "$OUT")"

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

health=$(curl -s --max-time 5 http://localhost:8787/healthz 2>/dev/null)
if [ -z "$health" ]; then
  echo "$ts  SERVER_DOWN" >> "$OUT"
  exit 0
fi

seq=$(printf '%s' "$health" | sed -n 's/.*"seq":\([0-9]*\).*/\1/p')
clients=$(printf '%s' "$health" | sed -n 's/.*"clients":\([0-9]*\).*/\1/p')

# Resident memory per process — the number that reveals a slow leak.
rss=$(for p in $(pgrep -f "tsx src/(index|cli)\.ts" 2>/dev/null); do
        ps -o rss= -p "$p" 2>/dev/null | tr -d ' '
      done | paste -sd, -)
procs=$(pgrep -f "tsx src/(index|cli)\.ts" 2>/dev/null | wc -l | tr -d ' ')

# Counts that should stay bounded or grow only with real work.
read -r events tasks stuck online <<EOF
$(sqlite3 "$DB" "
  SELECT (SELECT COUNT(*) FROM events),
         (SELECT COUNT(*) FROM tasks),
         (SELECT COUNT(*) FROM tasks WHERE state IN ('working','blocked')
            AND lease_expires IS NOT NULL AND lease_expires < datetime('now')),
         (SELECT COUNT(*) FROM machines WHERE online = 1);
" 2>/dev/null | tr '|' ' ')
EOF

# grep -c already prints 0 and exits 1 when there are no matches;
# a `|| echo 0` fallback would emit the count twice.
errors=$(grep -ciE "error|unhandled|ECONNREFUSED" /tmp/soak/server.log 2>/dev/null); errors=${errors:-0}

printf '%s  procs=%s rss=%s clients=%s seq=%s events=%s tasks=%s stuck_leases=%s machines_online=%s log_errors=%s\n' \
  "$ts" "$procs" "${rss:-none}" "${clients:-?}" "${seq:-?}" \
  "${events:-?}" "${tasks:-?}" "${stuck:-?}" "${online:-?}" "$errors" >> "$OUT"
