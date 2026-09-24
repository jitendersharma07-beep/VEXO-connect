#!/usr/bin/env bash
# VC-104 W2 — one-shot pipeline: seed W2's demo DB, start W1's backend
# READ-ONLY on 5382, start the vite dev server on 5383, run the browser QA,
# then stop both servers no matter how the run ends.
#
# Written for an operator shell during the Bash-classifier outage (same
# pattern as verify-kitchen.sh). Prints PASS/FAIL and counts only — the demo
# password is derived in-process (sha256 of the container's POSTGRES_PASSWORD,
# first 24 hex chars) and is never echoed, logged, or written to a file.
#
#   bash ~/vexo-connect-x-lanes/vc104-ui/frontend/qa/run-all.sh
#
# Logs: /tmp/vc104-ui-qa-<ts>/ {backend,vite,qa}.log + the harness's own
# qa/screens/{results.json,*.png}. Servers bind 127.0.0.1 only.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # …/vc104-ui/frontend/qa
FRONTEND="$(dirname "$HERE")"
BACKEND="$(cd "$FRONTEND/../../vc104-api/backend" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
LOGDIR="/tmp/vc104-ui-qa-$TS"
mkdir -p "$LOGDIR"

API_PORT=5382
UI_PORT=5383
CHROME="$HOME/.cache/ms-playwright/chromium-1117/chrome-linux/chrome"

fail() { echo "FAIL: $1 (logs: $LOGDIR)"; exit 1; }

[ -x "$CHROME" ] || fail "Chromium not found at $CHROME"

# Refuse to start on occupied ports rather than serving a stranger's process —
# unless the listener is OUR OWN orphan (cwd inside this lane / W1's backend
# tree), which we reap: killing `npx` used to leave its vite child alive, and
# that orphan blocked the next run.
for p in $API_PORT $UI_PORT; do
  pid="$(ss -ltnp "sport = :$p" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$pid" ] || continue
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || echo unknown)"
  case "$cwd" in
    "$FRONTEND"*|"$BACKEND"*)
      echo "   reaping our own orphan on :$p (pid $pid)"
      kill "$pid" 2>/dev/null; sleep 1
      if ss -ltn "sport = :$p" | grep -q LISTEN; then fail "port $p still in use after reap"; fi ;;
    *) fail "port $p already in use by a foreign process (pid $pid, cwd $cwd)" ;;
  esac
done

# The lane was cut while npm was unavailable, so it has no node_modules.
# frontend/package.json is byte-identical to vc105-ui's — clone that install.
if [ ! -d "$FRONTEND/node_modules" ]; then
  SRC="$(cd "$FRONTEND/../../vc105-ui/frontend" && pwd)/node_modules"
  [ -d "$SRC" ] || fail "no node_modules here and none to borrow at $SRC"
  echo "== 0/4 node_modules missing — copying vc105-ui's (~141M, identical package.json)"
  cp -a "$SRC" "$FRONTEND/node_modules" || fail "node_modules copy"
fi

PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD)" || fail "cannot read DB password from container"
DERIVED="$(printf %s "$PW" | sha256sum | cut -c1-24)"
# URL-encode the password (same as run-seed.mjs); env-passed so it never hits argv.
DB_URL="$(PW="$PW" node -e 'console.log(`postgresql://atc_pos:${encodeURIComponent(process.env.PW)}@127.0.0.1:5439/atc_pos_vc104ui_demo`)')" \
  || fail "cannot build DB URL"

# Hermetic per run: the harness asserts empty-state and capacity maths that a
# previous run's leftover orders would poison, and the seed only tops up. This
# is W2's OWN scratch DB — dropping it touches nobody else's evidence.
echo "== 1/4 reset DB + migrate + seed (stdout swallowed by the runner; counts below)"
docker exec atc-pos-dev-db psql -U atc_pos -d postgres -q \
  -c 'DROP DATABASE IF EXISTS atc_pos_vc104ui_demo WITH (FORCE)' \
  -c 'CREATE DATABASE atc_pos_vc104ui_demo' || fail "db reset"
cat "$BACKEND/prisma/migrations"/*/migration.sql \
  | docker exec -i atc-pos-dev-db psql -v ON_ERROR_STOP=1 -U atc_pos -d atc_pos_vc104ui_demo -q \
  || fail "migrations"
node "$HERE/run-seed.mjs" || fail "seed"

# W1's backend refuses to boot without POS_JWT_SECRET (>=32 chars). Per-run
# random; lives only in this process tree, never echoed or written anywhere.
JWT="$(head -c 32 /dev/urandom | sha256sum | cut -c1-64)"

echo "== 2/4 backend (W1 tree read-only) on 127.0.0.1:$API_PORT"
( cd "$BACKEND" && PORT=$API_PORT HOST=127.0.0.1 \
    CORS_ORIGIN="http://127.0.0.1:$UI_PORT" \
    DATABASE_URL="$DB_URL" \
    POS_JWT_SECRET="$JWT" \
    exec node src/index.js >"$LOGDIR/backend.log" 2>&1 ) &
BACK_PID=$!

echo "== 3/4 vite on 127.0.0.1:$UI_PORT (strictPort; config host:true is overridden)"
# Local binary via exec, NOT npx: $VITE_PID must be vite itself so cleanup kills
# the real server instead of a wrapper whose child survives as an orphan.
( cd "$FRONTEND" && VITE_DEV_API="http://127.0.0.1:$API_PORT" \
    exec node_modules/.bin/vite --port $UI_PORT --strictPort --host 127.0.0.1 \
    >"$LOGDIR/vite.log" 2>&1 ) &
VITE_PID=$!

cleanup() {
  kill "$BACK_PID" "$VITE_PID" 2>/dev/null
  wait "$BACK_PID" "$VITE_PID" 2>/dev/null
}
trap cleanup EXIT

for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  kill -0 "$BACK_PID" 2>/dev/null || fail "backend died — read $LOGDIR/backend.log"
  sleep 1
  [ "$i" = 30 ] && fail "backend never answered /health — read $LOGDIR/backend.log"
done
echo "   backend up"

for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$UI_PORT/" >/dev/null 2>&1 && break
  kill -0 "$VITE_PID" 2>/dev/null || fail "vite died — read $LOGDIR/vite.log"
  sleep 1
  [ "$i" = 30 ] && fail "vite never answered — read $LOGDIR/vite.log"
done
echo "   vite up"

echo "== 4/4 browser QA"
QA_UI="http://127.0.0.1:$UI_PORT" QA_API="http://127.0.0.1:$API_PORT" \
QA_OWNER=demo.owner@atcpos.example \
QA_MANAGER=demo.manager@atcpos.example \
QA_CASHIER=demo.cashier@atcpos.example \
QA_PASSWORD="$DERIVED" \
QA_CHROME="$CHROME" \
QA_OUT="$HERE/screens" \
node "$HERE/vc104-browser-qa.mjs" >"$LOGDIR/qa.log" 2>&1
QA_EXIT=$?

tail -n 3 "$LOGDIR/qa.log"
echo "results: $HERE/screens/results-vc104.json  screenshots: $HERE/screens/  logs: $LOGDIR"
if [ "$QA_EXIT" = 0 ]; then echo "PASS: vc104-ui browser QA"; else echo "FAIL: browser QA exit $QA_EXIT — read $LOGDIR/qa.log"; fi

# NOT RUN HERE: vc105-browser-qa.mjs. It arrived with x/vc105-ui, which shipped
# no runner, and it needs backend/scripts/vc105-seed-demo.mjs rather than the
# run-seed.mjs above — different fixtures, so it cannot just be appended to
# this script. Until that seeding step exists, the only VC-105 browser evidence
# in the tree is screens/results-vc105.json from the lane's own 47/47 run
# (recorded with no timestamp, against ports 5386/5387, BEFORE consolidation).
# Treat it as a lane result, not as evidence about this tree. See D-4 in
# docs/VC104-BACKEND-DEFECTS.md.
exit "$QA_EXIT"
