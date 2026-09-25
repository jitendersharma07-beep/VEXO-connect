#!/bin/bash
# Inspect or migrate one of this lane's own reporting databases.
#
# Credentials are handled exactly as scripts/reporting-test.sh does: read from
# the dev container's own environment, passed to one child process, never in
# argv, history or a file.
#
#   bash scripts/reporting-db.sh status    # which migrations are applied
#   bash scripts/reporting-db.sh deploy    # apply pending migrations
#
#   REPORTING_TEST_DB=atc_pos_reporting_demo bash scripts/reporting-db.sh deploy
#
# `deploy` applies migrations forward only. It never resets, never drops and
# never rewrites an applied migration, so it is safe against a populated
# database — which is also why there is no `reset` subcommand here at all.
#
# The name guard admits the two suffixes this lane owns and nothing else, so a
# mistyped name cannot reach a shared or a production database. It is deliberately
# independent of tests/globalSetup.js: a guard that reads the same constant as the
# thing it guards checks nothing.

set -uo pipefail

CMD="${1:-status}"
DB="${REPORTING_TEST_DB:-atc_pos_reporting_test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "FAIL: $1"; exit 2; }

case "$DB" in
  *_test|*_demo) : ;;
  *) fail "refusing: '$DB' is not one of this lane's databases (*_test, *_demo)" ;;
esac

case "$CMD" in
  status|deploy) : ;;
  *) fail "unknown command '$CMD' (expected: status, deploy)" ;;
esac

PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || fail "dev database container atc-pos-dev-db is not running"

EXISTS="$(docker exec atc-pos-dev-db psql -U atc_pos -d postgres -tAc \
  "select 1 from pg_database where datname = '$DB'" 2>/dev/null)"
[ "$EXISTS" = "1" ] || fail "database '$DB' does not exist — create it first"

cd "$HERE" || fail "backend directory not found at $HERE"
echo "database: $DB (127.0.0.1:5439)"
DATABASE_URL="postgresql://atc_pos:${PW}@127.0.0.1:5439/${DB}?schema=public" \
  npx prisma migrate "$CMD"
STATUS=$?
unset PW
exit "$STATUS"
