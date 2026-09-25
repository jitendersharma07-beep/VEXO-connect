#!/bin/bash
# Run this lane's backend tests against the reporting TEST database.
#
# The database password is read from the dev container's own environment and
# passed to one child process. It is never in argv, never in shell history and
# never written to disk — which is also why there is no DATABASE_URL in .env.
#
# Refuses any database whose name does not end in _test, independently of
# tests/globalSetup.js, so a mistyped name cannot reach a shared database. Passes
# its arguments straight through to vitest, so a single file or the whole gate
# both work:
#
#   bash scripts/reporting-test.sh                       # whole gate
#   bash scripts/reporting-test.sh tests/reportingPeriod.test.js

set -uo pipefail

DB="${REPORTING_TEST_DB:-atc_pos_reporting_test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "FAIL: $1"; exit 2; }

case "$DB" in
  *_test) : ;;
  *) fail "refusing: '$DB' is not a test database" ;;
esac

PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || fail "dev database container atc-pos-dev-db is not running"

EXISTS="$(docker exec atc-pos-dev-db psql -U atc_pos -d postgres -tAc \
  "select 1 from pg_database where datname = '$DB'" 2>/dev/null)"
[ "$EXISTS" = "1" ] || fail "database '$DB' does not exist — create it before running the gate"

cd "$HERE" || fail "backend directory not found at $HERE"
DATABASE_URL="postgresql://atc_pos:${PW}@127.0.0.1:5439/${DB}?schema=public" \
  npx vitest run "$@"
STATUS=$?
unset PW
exit "$STATUS"
