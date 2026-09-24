#!/usr/bin/env bash
# VC-104 + VC-105 — one-shot pipeline against THIS tree.
#
# Seeds two scratch databases, starts THIS repo's backend and vite dev server
# on loopback, runs both browser harnesses, and stops every server it started
# no matter how the run ends.
#
# What changed on 2026-09-24, and why it matters more than it looks:
# this script used to resolve $BACKEND to ../../vc104-api/backend — W1's LANE.
# That was correct while the file lived in W2's frontend lane and the only
# backend in reach was a peer's. After a406 consolidation it was wrong in
# exactly the way D-4 describes: the script sat in main, and migrated, seeded
# and served the lane. A green run printed here was evidence about the lane's
# 14 migrations, not about main's 22 — and nothing in the output said so.
# $BACKEND is now $REPO/backend, and the harnesses stamp the checkout they ran
# from into their results files (qa/tree-stamp.mjs), so the next time these two
# come apart the artifact says which tree it came from.
#
# Written for an operator shell (same pattern as verify-kitchen.sh). Prints
# PASS/FAIL and counts only — the demo password is derived in-process (sha256
# of the container's POSTGRES_PASSWORD, first 24 hex chars) and is never
# echoed, logged, or written to a file.
#
#   bash ~/vexo-connect-x-lanes/main-merge/frontend/qa/run-all.sh
#
# Logs: /tmp/vcx-qa-<ts>/ {provision,vc104-backend,vc104-vite,vc104-qa,
# vc105-backend,vc105-vite,vc105-qa}.log, plus each harness's own
# qa/screens/{results-vc104.json,results-vc105.json,*.png}.
# Servers bind 127.0.0.1 only.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # …/frontend/qa
FRONTEND="$(dirname "$HERE")"
REPO="$(dirname "$FRONTEND")"
BACKEND="$REPO/backend"
LANES="$(dirname "$REPO")"
TS="$(date +%Y%m%d-%H%M%S)"
LOGDIR="/tmp/vcx-qa-$TS"
mkdir -p "$LOGDIR"

VC104_API=5382; VC104_UI=5383; VC104_DB=atc_pos_vc104ui_demo
VC105_API=5386; VC105_UI=5387; VC105_DB=vcx_vc105_main_demo
CHROME="$HOME/.cache/ms-playwright/chromium-1117/chrome-linux/chrome"

fail() { echo "FAIL: $1 (logs: $LOGDIR)"; exit 1; }

[ -x "$CHROME" ] || fail "Chromium not found at $CHROME"
[ -d "$BACKEND/prisma/migrations" ] || fail "no backend in this tree at $BACKEND"

# Refuse to start on occupied ports rather than serving a stranger's process —
# unless the listener is OUR OWN orphan (cwd inside this checkout), which we
# reap: killing `npx` used to leave its vite child alive, and that orphan
# blocked the next run while a curl readiness probe passed against it.
for p in $VC104_API $VC104_UI $VC105_API $VC105_UI; do
  pid="$(ss -ltnp "sport = :$p" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
  [ -n "$pid" ] || continue
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || echo unknown)"
  case "$cwd" in
    "$REPO"*)
      echo "   reaping our own orphan on :$p (pid $pid)"
      kill "$pid" 2>/dev/null; sleep 1
      if ss -ltn "sport = :$p" | grep -q LISTEN; then fail "port $p still in use after reap"; fi ;;
    *) fail "port $p already in use by a foreign process (pid $pid, cwd $cwd)" ;;
  esac
done

echo "== 0/6 provision node_modules + a prisma client generated from THIS schema"
# package.json here is byte-identical to the lanes' (verified with cmp), so a
# copy is a legitimate install. node_modules is gitignored, so a fresh checkout
# of main has neither.
if [ ! -d "$FRONTEND/node_modules" ]; then
  SRC="$LANES/vc105-ui/frontend/node_modules"
  [ -d "$SRC" ] || fail "no frontend node_modules here and none to borrow at $SRC"
  echo "   copying frontend node_modules (~141M)"
  cp -a "$SRC" "$FRONTEND/node_modules" || fail "frontend node_modules copy"
fi
if [ ! -d "$BACKEND/node_modules" ]; then
  SRC="$LANES/vc105-api/backend/node_modules"
  [ -d "$SRC" ] || fail "no backend node_modules here and none to borrow at $SRC"
  echo "   copying backend node_modules (~134M)"
  cp -a "$SRC" "$BACKEND/node_modules" || fail "backend node_modules copy"
fi

# ALWAYS regenerate, and then prove it. A borrowed node_modules carries the
# lane's generated client, built from the lane's 792-line schema; main's is
# 2211 lines. Serving main's code against a lane's client fails deep inside a
# request as "prisma.branchPrepCapacity is undefined" — a runtime shape error
# that looks like application breakage, not like a stale build artifact.
# Generating is a few seconds and removes the question entirely.
( cd "$BACKEND" && node_modules/.bin/prisma generate ) >"$LOGDIR/provision.log" 2>&1 \
  || fail "prisma generate — read $LOGDIR/provision.log"
# Positive control on the generated client: BranchPrepCapacity is in main's
# schema and in NEITHER lane's client, so its presence proves the client came
# from this tree's schema and not from whichever lane we copied.
CLIENT_DTS="$BACKEND/node_modules/.prisma/client/index.d.ts"
grep -q "BranchPrepCapacity" "$CLIENT_DTS" \
  || fail "generated prisma client has no BranchPrepCapacity — it is not this tree's schema"
echo "   prisma client generated from $REPO/backend/prisma/schema.prisma ($(ls "$BACKEND/prisma/migrations" | grep -c '^2') migrations)"

PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD)" || fail "cannot read DB password from container"
DERIVED="$(printf %s "$PW" | sha256sum | cut -c1-24)"
# URL-encode the password (same as run-seed.mjs); env-passed so it never hits argv.
db_url() {
  PW="$PW" DB="$1" node -e 'console.log(`postgresql://atc_pos:${encodeURIComponent(process.env.PW)}@127.0.0.1:5439/${process.env.DB}`)' \
    || fail "cannot build DB URL for $1"
}

# Hermetic per run: both harnesses assert empty-state and capacity maths that a
# previous run's leftover rows would poison, and the seeds only top up. These
# are W2's OWN scratch databases — dropping them touches nobody else's
# evidence. W1's atc_pos_vc104api_* and vcx_vc105_{api_test,snapshot_v1} are
# never named here.
db_reset() {
  docker exec atc-pos-dev-db psql -U atc_pos -d postgres -q \
    -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" \
    -c "CREATE DATABASE $1" || { echo "   db reset $1 failed"; return 1; }
  cat "$BACKEND/prisma/migrations"/*/migration.sql \
    | docker exec -i atc-pos-dev-db psql -v ON_ERROR_STOP=1 -U atc_pos -d "$1" -q \
    || { echo "   migrations $1 failed"; return 1; }
}

# The backend refuses to boot without POS_JWT_SECRET (>=32 chars). Per-run
# random; lives only in this process tree, never echoed or written anywhere.
JWT="$(head -c 32 /dev/urandom | sha256sum | cut -c1-64)"

BACK_PID=""; VITE_PID=""
stop_servers() {
  [ -n "$BACK_PID$VITE_PID" ] || return 0
  kill $BACK_PID $VITE_PID 2>/dev/null
  wait $BACK_PID $VITE_PID 2>/dev/null
  BACK_PID=""; VITE_PID=""
}
trap stop_servers EXIT

# Poll until the server answers, but give up the moment the process dies —
# otherwise a backend that exits on a bad env var costs 30s of silence.
wait_http() { # url pid what log
  for i in $(seq 1 40); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    kill -0 "$2" 2>/dev/null || { echo "   $3 died — read $4"; return 1; }
    sleep 1
  done
  echo "   $3 never answered — read $4"
  return 1
}

start_vite() { # ui_port api_port log
  # Local binary via exec, NOT npx: $VITE_PID must be vite itself so cleanup
  # kills the real server instead of a wrapper whose child survives as an
  # orphan. config has host:true and port 5177; both are overridden here.
  ( cd "$FRONTEND" && VITE_DEV_API="http://127.0.0.1:$2" \
      exec node_modules/.bin/vite --port "$1" --strictPort --host 127.0.0.1 \
      >"$3" 2>&1 ) &
  VITE_PID=$!
}

# Each stage RETURNS its status rather than calling fail(), so a broken setup
# in one does not discard the other's result. The first version of this script
# used fail() throughout, and a VC-105 seed crash exited before the VC-104
# result it had already collected was ever printed.
# ---------------------------------------------------------------- VC-104 ----
vc104_stage() {
  echo "== 1/6 VC-104: reset + migrate + seed $VC104_DB"
  db_reset "$VC104_DB" || return 1
  QA_DB="$VC104_DB" node "$HERE/run-seed.mjs" || return 1

  echo "== 2/6 VC-104: backend :$VC104_API + vite :$VC104_UI"
  ( cd "$BACKEND" && PORT=$VC104_API HOST=127.0.0.1 \
      CORS_ORIGIN="http://127.0.0.1:$VC104_UI" \
      DATABASE_URL="$(db_url "$VC104_DB")" \
      POS_JWT_SECRET="$JWT" \
      exec node src/index.js >"$LOGDIR/vc104-backend.log" 2>&1 ) &
  BACK_PID=$!
  wait_http "http://127.0.0.1:$VC104_API/health" "$BACK_PID" "vc104 backend" "$LOGDIR/vc104-backend.log" \
    || return 1
  start_vite "$VC104_UI" "$VC104_API" "$LOGDIR/vc104-vite.log"
  wait_http "http://127.0.0.1:$VC104_UI/" "$VITE_PID" "vc104 vite" "$LOGDIR/vc104-vite.log" \
    || return 1

  echo "== 3/6 VC-104: browser QA"
  QA_UI="http://127.0.0.1:$VC104_UI" QA_API="http://127.0.0.1:$VC104_API" \
  QA_OWNER=demo.owner@atcpos.example \
  QA_MANAGER=demo.manager@atcpos.example \
  QA_CASHIER=demo.cashier@atcpos.example \
  QA_PASSWORD="$DERIVED" \
  QA_CHROME="$CHROME" \
  QA_OUT="$HERE/screens" \
  node "$HERE/vc104-browser-qa.mjs" >"$LOGDIR/vc104-qa.log" 2>&1
  local rc=$?
  tail -n 2 "$LOGDIR/vc104-qa.log"
  return $rc
}

# ---------------------------------------------------------------- VC-105 ----
# Different fixtures, so this could never have been appended to the VC-104
# stage: VC-105 needs backend/scripts/vc105-seed-demo.mjs (a synthetic menu
# with known costs), not prisma/seed.js, and the API must run with the
# synthetic cost provider or every row reports MISSING. That is why this stage
# did not exist until now, and why D-4's second half stayed open.
vc105_stage() {
  echo "== 4/6 VC-105: reset + migrate + seed $VC105_DB"
  db_reset "$VC105_DB" || return 1
  # The seed refuses unless the database name contains "vc105" and NODE_ENV is
  # not production — a guard against seeding a peer's or a real database. Its
  # stdout is a fixture summary and prints no password, but it goes to the log
  # anyway so this script's own output stays counts-only.
  ( cd "$BACKEND" && DATABASE_URL="$(db_url "$VC105_DB")" POS_SEED_PASSWORD="$DERIVED" \
      node scripts/vc105-seed-demo.mjs >"$LOGDIR/vc105-seed.log" 2>&1 ) \
    || { echo "   seed failed — read $LOGDIR/vc105-seed.log"; return 1; }
  local users orders items
  users="$(vc105_count 'SELECT count(*) FROM "PosUser"')"
  orders="$(vc105_count 'SELECT count(*) FROM "Order"')"
  items="$(vc105_count 'SELECT count(*) FROM "OrderItem"')"
  echo "   PosUser=$users Order=$orders OrderItem=$items"
  { [ "$users" -ge 3 ] && [ "$orders" -ge 5 ] && [ "$items" -ge 5 ]; } \
    || { echo "   unexpected row counts"; return 1; }

  echo "== 5/6 VC-105: backend :$VC105_API (synthetic cost provider) + vite :$VC105_UI"
  ( cd "$BACKEND" && PORT=$VC105_API HOST=127.0.0.1 \
      CORS_ORIGIN="http://127.0.0.1:$VC105_UI" \
      DATABASE_URL="$(db_url "$VC105_DB")" \
      POS_JWT_SECRET="$JWT" \
      VC105_SYNTHETIC_COSTS=1 \
      VC105_SYNTHETIC_COST_FILE="$BACKEND/tests/fixtures/vc105-synthetic-costs.json" \
      exec node src/index.js >"$LOGDIR/vc105-backend.log" 2>&1 ) &
  BACK_PID=$!
  wait_http "http://127.0.0.1:$VC105_API/health" "$BACK_PID" "vc105 backend" "$LOGDIR/vc105-backend.log" \
    || return 1
  start_vite "$VC105_UI" "$VC105_API" "$LOGDIR/vc105-vite.log"
  wait_http "http://127.0.0.1:$VC105_UI/" "$VITE_PID" "vc105 vite" "$LOGDIR/vc105-vite.log" \
    || return 1

  echo "== 6/6 VC-105: browser QA"
  QA_UI="http://127.0.0.1:$VC105_UI" QA_API="http://127.0.0.1:$VC105_API" \
  QA_OWNER=owner@vc105.demo.local \
  QA_MANAGER=manager.central@vc105.demo.local \
  QA_CASHIER=cashier@vc105.demo.local \
  QA_PASSWORD="$DERIVED" \
  QA_CHROME="$CHROME" \
  QA_OUT="$HERE/screens" \
  node "$HERE/vc105-browser-qa.mjs" >"$LOGDIR/vc105-qa.log" 2>&1
  local rc=$?
  tail -n 2 "$LOGDIR/vc105-qa.log"
  return $rc
}
vc105_count() {
  docker exec atc-pos-dev-db psql -U atc_pos -d "$VC105_DB" -Atc "$1" | tr -d '[:space:]'
}

vc104_stage; VC104_EXIT=$?
stop_servers
vc105_stage; VC105_EXIT=$?
stop_servers

echo
echo "results: $HERE/screens/results-vc104.json + results-vc105.json"
echo "screenshots: $HERE/screens/   logs: $LOGDIR"
[ "$VC104_EXIT" = 0 ] && echo "PASS: VC-104 browser QA" || echo "FAIL: VC-104 browser QA exit $VC104_EXIT — read $LOGDIR/vc104-qa.log"
[ "$VC105_EXIT" = 0 ] && echo "PASS: VC-105 browser QA" || echo "FAIL: VC-105 browser QA exit $VC105_EXIT — read $LOGDIR/vc105-qa.log"

# Both results files now carry tree/branch/baseSha. If either names a path
# outside this checkout, the file did not come from this run — that is D-4's
# whole failure mode, and it is now visible in the artifact itself.
[ "$VC104_EXIT" = 0 ] && [ "$VC105_EXIT" = 0 ]
