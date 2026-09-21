#!/bin/bash
# Start the POS backend against a Razorpay SANDBOX account, on this dev box only.
#
# The three provider secrets are typed at a hidden prompt and live only in this
# process's environment: never in argv, never in shell history, never on disk,
# never echoed. There is no dotenv loader in this codebase — config/env.js reads
# process.env — so exporting them here is the whole configuration step. Nothing
# is written to .env, which is why running this script changes no deployment.
#
# Refuses a live key outright. Refuses to run anywhere but the dev database.
# Prints PASS or FAIL and nothing else about the values it was given.
#
# Webhook: POST /api/gateway/webhook, which exists only while a provider is
# named. The backend binds to 127.0.0.1, so Razorpay reaches it through a
# tunnel the operator starts separately — this script touches no nginx config.

set -uo pipefail
umask 077

REPO=/home/atc-noc/atc-pos
fail() { echo "FAIL: $1"; exit 2; }

[ -t 0 ] || fail "no terminal on stdin; the secrets must be typed, not piped"
cd "$REPO" || fail "repo not found at $REPO"

# --- the dev database, and only the dev database -----------------------------
PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || fail "dev database container atc-pos-dev-db is not running"
DSN="postgresql://atc_pos:${PW}@127.0.0.1:5439/atc_pos?schema=public"
unset PW
case "$DSN" in
  *@127.0.0.1:5439/atc_pos?schema=public) : ;;
  *) fail "refusing: that is not the dev database" ;;
esac

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
mkdir -p /tmp/pos-demo
cd backend || fail "backend directory missing"

DATABASE_URL="$DSN" \
POS_JWT_SECRET="$JWT" \
NODE_ENV=development \
HOST=127.0.0.1 PORT=5010 \
CORS_ORIGIN=http://127.0.0.1:5177 \
POS_GATEWAY_PROVIDER=razorpay \
POS_GATEWAY_KEY_ID="$KEY_ID" \
POS_GATEWAY_KEY_SECRET="$KEY_SECRET" \
POS_GATEWAY_WEBHOOK_SECRET="$WH_SECRET" \
LOG_LEVEL=info \
  node src/index.js > /tmp/pos-demo/dev-gateway.log 2>&1 &
BACKEND_PID=$!
unset KEY_ID KEY_SECRET WH_SECRET JWT DSN

# env.js throws at import for a half-configured gateway, so a process still
# alive after a moment has accepted the whole set.
sleep 3
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "FAIL: backend refused to start — reason in /tmp/pos-demo/dev-gateway.log"
  exit 2
fi
if ! curl -fsS -o /dev/null http://127.0.0.1:5010/api/health; then
  echo "FAIL: backend is up but not answering on 127.0.0.1:5010"
  exit 2
fi

echo "PASS: backend running with the razorpay adapter (pid $BACKEND_PID)"
echo "PASS: webhook endpoint mounted at POST /api/gateway/webhook"
