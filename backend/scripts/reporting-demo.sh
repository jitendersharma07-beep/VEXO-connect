#!/bin/bash
# Start, stop or inspect this lane's own reporting demo stack.
#
#   bash scripts/reporting-demo.sh up       # start API and UI
#   bash scripts/reporting-demo.sh status   # is it listening, on what
#   bash scripts/reporting-demo.sh down     # stop the two processes it started
#
# Credentials are handled as scripts/reporting-test.sh does: read from the dev
# container's own environment, passed to one child process, never in argv, never
# in history, never written to disk. Nothing here echoes a password or a token,
# because a scrollback gets pasted into a chat window sooner or later.
#
# WHY THIS EXISTS RATHER THAN A pkill
#
# This server runs many workers' lanes, and a great number of unrelated
# processes answer to `pkill -f "node src/index.js"`. Stopping this stack by
# pattern would take other people's work down with it. So `up` records the two
# pids it created and `down` will only signal those, after confirming the pid is
# still the process that was started — a pid is reused, and killing whatever
# inherited the number is the same mistake wearing a disguise.
#
# The database guard admits *_demo and nothing else, so a mistyped name cannot
# point this stack at a shared or a production database.

set -uo pipefail

CMD="${1:-status}"
DB="${REPORTING_DEMO_DB:-atc_pos_reporting_demo}"
API_PORT="${REPORTING_DEMO_API_PORT:-5560}"
UI_PORT="${REPORTING_DEMO_UI_PORT:-5188}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANE="$(cd "$HERE/.." && pwd)"
RUN="$HERE/.demo-run"
API_LOG=/tmp/reporting-api.log
UI_LOG=/tmp/reporting-vite.log

fail() { echo "FAIL: $1"; exit 2; }

case "$DB" in
  *_demo) : ;;
  *) fail "refusing: '$DB' is not this lane's demo database (*_demo)" ;;
esac

# Only signal a pid this script started, and only if it is still the same
# process. `ps -o lstart` is the cheapest identity check available: a recycled
# pid will not have the start time we recorded.
#
# Each child is started with setsid, so its pid is also its process-group id and
# `kill -- -pid` reaches the whole group and nothing outside it. That matters for
# the UI: `npx vite` is three processes deep, and signalling only the one we
# forked leaves the actual listener holding the port.
stop_recorded() {
  # Separate statements on purpose: bash expands every word of a single `local`
  # before any of its assignments take effect, so a one-liner referring to $name
  # would read it unset and, under `set -u`, abort the stop entirely.
  local name="$1"
  local pidfile="$RUN/$name.pid"
  local stampfile="$RUN/$name.lstart"
  [ -f "$pidfile" ] || { echo "$name: no pid recorded"; return 0; }
  local pid; pid="$(cat "$pidfile")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name: pid $pid already gone"
    rm -f "$pidfile" "$stampfile"; return 0
  fi
  local now; now="$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ')"
  local was; was="$(tr -s ' ' < "$stampfile" 2>/dev/null)"
  if [ -n "$was" ] && [ "$now" != "$was" ]; then
    echo "$name: REFUSING to signal pid $pid — it is not the process this script started"
    rm -f "$pidfile" "$stampfile"; return 0
  fi
  kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  kill -0 "$pid" 2>/dev/null && echo "$name: pid $pid did not stop" || echo "$name: stopped pid $pid"
  rm -f "$pidfile" "$stampfile"
}

record() {
  local name="$1" pid="$2"
  mkdir -p "$RUN"
  echo "$pid" > "$RUN/$name.pid"
  ps -o lstart= -p "$pid" 2>/dev/null > "$RUN/$name.lstart"
}

port_busy() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

case "$CMD" in
  status)
    echo "database: $DB (127.0.0.1:5439)"
    port_busy "$API_PORT" && echo "api: listening on 127.0.0.1:$API_PORT" || echo "api: not listening on $API_PORT"
    port_busy "$UI_PORT"  && echo "ui:  listening on 127.0.0.1:$UI_PORT"  || echo "ui:  not listening on $UI_PORT"
    for n in api ui; do
      [ -f "$RUN/$n.pid" ] && echo "$n pid recorded by this script: $(cat "$RUN/$n.pid")"
    done
    exit 0
    ;;
  down)
    stop_recorded api
    stop_recorded ui
    exit 0
    ;;
  up) : ;;
  *) fail "unknown command '$CMD' (expected: up, status, down)" ;;
esac

# A component already listening is left strictly alone. It may well be another
# worker's, and on this server it usually is; even when it is this lane's own it
# is serving something, and taking it down to replace it with an identical
# process is a risk taken for no gain. `up` is therefore safe to re-run.
START_API=1; START_UI=1
port_busy "$API_PORT" && START_API=0
port_busy "$UI_PORT"  && START_UI=0

PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || fail "dev database container atc-pos-dev-db is not running"

EXISTS="$(docker exec atc-pos-dev-db psql -U atc_pos -d postgres -tAc \
  "select 1 from pg_database where datname = '$DB'" 2>/dev/null)"
[ "$EXISTS" = "1" ] || fail "database '$DB' does not exist — create and migrate it first"

# The backend loads no .env of its own (there is no dotenv in this build), so
# every variable it requires has to be handed to it here or it exits on boot.
JWT="$(sed -n 's/^POS_JWT_SECRET=//p' "$HERE/.env" 2>/dev/null | head -1)"
[ -n "$JWT" ] || fail "POS_JWT_SECRET not found in backend/.env"

if [ "$START_API" = 1 ]; then
  cd "$HERE" || fail "backend directory not found at $HERE"
  DATABASE_URL="postgresql://atc_pos:${PW}@127.0.0.1:5439/${DB}?schema=public" \
  POS_JWT_SECRET="$JWT" \
  NODE_ENV=development PORT="$API_PORT" HOST=127.0.0.1 \
  CORS_ORIGIN="http://127.0.0.1:${UI_PORT}" \
    setsid nohup node src/index.js > "$API_LOG" 2>&1 &
  record api $!
fi
unset PW JWT

if [ "$START_UI" = 1 ]; then
  cd "$LANE/frontend" || fail "frontend directory not found at $LANE/frontend"
  # VITE_DEV_API is an ORIGIN, not a base path: vite.config.js proxies /api to it
  # unchanged, so appending /api here would ask the backend for /api/api.
  VITE_DEV_API="http://127.0.0.1:${API_PORT}" \
    setsid nohup npx vite --host 127.0.0.1 --port "$UI_PORT" --strictPort > "$UI_LOG" 2>&1 &
  record ui $!
fi

for _ in $(seq 1 40); do
  port_busy "$API_PORT" && break
  sleep 0.5
done
for _ in $(seq 1 40); do
  port_busy "$UI_PORT" && break
  sleep 0.5
done

API_OK=0; UI_OK=0
port_busy "$API_PORT" && API_OK=1
port_busy "$UI_PORT" && UI_OK=1
[ "$START_API" = 1 ] && API_WORD=started || API_WORD="already up, left alone"
[ "$START_UI" = 1 ]  && UI_WORD=started  || UI_WORD="already up, left alone"

echo "database: $DB"
[ "$API_OK" = 1 ] && echo "PASS api  http://127.0.0.1:${API_PORT}/api  ($API_WORD; log: $API_LOG)" || echo "FAIL api did not start — see $API_LOG"
[ "$UI_OK" = 1 ]  && echo "PASS ui   http://127.0.0.1:${UI_PORT}/       ($UI_WORD; log: $UI_LOG)"  || echo "FAIL ui did not start — see $UI_LOG"
[ "$API_OK" = 1 ] && [ "$UI_OK" = 1 ] || exit 1
exit 0
