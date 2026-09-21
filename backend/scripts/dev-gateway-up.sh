#!/bin/bash
# Start the POS backend against a Razorpay SANDBOX account, on this dev box only.
#
# The three provider secrets are typed at a hidden prompt and live only in this
# process's environment: never in argv, never in shell history, never on disk,
# never echoed. There is no dotenv loader in this codebase — config/env.js reads
# process.env — so exporting them here is the whole configuration step. Nothing
# is written to .env, which is why running this script changes no deployment.
#
# Runs in the FOREGROUND and owns this terminal: Ctrl-C stops the backend it
# started, and nothing is left orphaned. The frontend needs its own terminal.
#
# Refuses a live key, refuses anything but the dev database, refuses to start if
# the dev database is behind on migrations, and refuses — without killing
# anything — if something already holds the port.

set -uo pipefail
umask 077

REPO=/home/atc-noc/atc-pos
PORT=5010
LOG=/tmp/pos-demo/dev-gateway.log
fail() { echo "FAIL: $1"; exit 2; }

[ -t 0 ] || fail "no terminal on stdin; the secrets must be typed, not piped"
cd "$REPO" || fail "repo not found at $REPO"
mkdir -p /tmp/pos-demo

# --- do not disturb anything already running ---------------------------------
# Identify the holder and stop; never kill it. It may be a colleague's session,
# or the plain dev backend, and neither is this script's to end.
HOLDER="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
if [ -n "$HOLDER" ]; then
  echo "FAIL: port $PORT is already held by pid $HOLDER:"
  ps -o pid=,args= -p "$HOLDER" 2>/dev/null | sed 's/^/       /'
  echo "       Stop that process yourself if it is yours, then run this again."
  echo "       Nothing has been started or killed."
  exit 2
fi

# --- the dev database, and only the dev database -----------------------------
PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || fail "dev database container atc-pos-dev-db is not running"
DSN="postgresql://atc_pos:${PW}@127.0.0.1:5439/atc_pos?schema=public"
unset PW
case "$DSN" in
  *@127.0.0.1:5439/atc_pos?schema=public) : ;;
  *) fail "refusing: that is not the dev database" ;;
esac

# --- the schema the gateway actually needs -----------------------------------
# A backend whose code is ahead of its database does not fail at boot; it fails
# at the first refund, on a column that is not there. Compare the migration
# directories against what the database records as applied, and name the gap.
APPLIED="$(docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -tAc \
  "select migration_name from _prisma_migrations where finished_at is not null" 2>/dev/null)"
[ -n "$APPLIED" ] || fail "could not read _prisma_migrations from the dev database"
MISSING=""
for m in backend/prisma/migrations/*/; do
  n="$(basename "$m")"
  [ "$n" = "migration_lock.toml" ] && continue
  grep -qx "$n" <<< "$APPLIED" || MISSING="$MISSING $n"
done
if [ -n "$MISSING" ]; then
  echo "FAIL: the dev database is behind on migrations:$MISSING"
  echo "       Apply them first:"
  echo "         cd $REPO/backend && npx prisma migrate deploy"
  echo "       (with DATABASE_URL pointing at the dev database)"
  exit 2
fi

# --- the provider secrets ----------------------------------------------------
printf 'Razorpay TEST key id (rzp_test_...): '
read -rs KEY_ID; echo
printf 'Razorpay TEST key secret: '
read -rs KEY_SECRET; echo
printf 'Webhook secret — the SAME string you put in the Razorpay webhook form: '
read -rs WH_SECRET; echo

case "$KEY_ID" in
  *_live_*) fail "that is a LIVE key; this script runs sandbox keys only" ;;
  rzp_test_*) : ;;
  *) fail "key id does not look like a Razorpay test key" ;;
esac
[ -n "$KEY_SECRET" ] || fail "key secret is empty"
[ "${#WH_SECRET}" -ge 16 ] || fail "webhook secret must be at least 16 characters"

# Dev session-signing secret, fresh per run and never reused from production.
# Sessions do not survive a restart here, which is correct for a dev box.
JWT="${POS_JWT_SECRET:-$(openssl rand -hex 32)}"
[ "${#JWT}" -ge 32 ] || fail "POS_JWT_SECRET in the environment is too short"

# --- start -------------------------------------------------------------------
cd backend || fail "backend directory missing"
: > "$LOG"

DATABASE_URL="$DSN" \
POS_JWT_SECRET="$JWT" \
NODE_ENV=development \
HOST=127.0.0.1 PORT="$PORT" \
CORS_ORIGIN=http://127.0.0.1:5177 \
POS_GATEWAY_PROVIDER=razorpay \
POS_GATEWAY_KEY_ID="$KEY_ID" \
POS_GATEWAY_KEY_SECRET="$KEY_SECRET" \
POS_GATEWAY_WEBHOOK_SECRET="$WH_SECRET" \
LOG_LEVEL=info \
  node src/index.js > "$LOG" 2>&1 &
BACKEND_PID=$!
unset KEY_ID KEY_SECRET WH_SECRET JWT DSN

trap 'kill "$BACKEND_PID" 2>/dev/null; exit 0' INT TERM

# env.js throws at import for a half-configured gateway, so a process still
# alive after a moment has accepted the whole set.
sleep 3
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "FAIL: backend refused to start:"
  tail -3 "$LOG" | sed 's/^/       /'
  exit 2
fi
if ! curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  kill "$BACKEND_PID" 2>/dev/null
  fail "backend is up but not answering on 127.0.0.1:$PORT"
fi

echo "PASS: backend running with the razorpay adapter (pid $BACKEND_PID)"
echo "PASS: dev database has all migrations applied"
echo "PASS: webhook endpoint mounted at POST /api/gateway/webhook"
echo
echo "This terminal now owns the backend. Ctrl-C stops it."
tail -n 0 -f "$LOG" &
TAIL_PID=$!
wait "$BACKEND_PID"
kill "$TAIL_PID" 2>/dev/null
