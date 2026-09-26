#!/usr/bin/env bash
# Runs deploy/e2e-workflow.mjs against a FRESH database, served by its own
# backend on 127.0.0.1:${E2E_PORT:-5011}, with a local mail sink on
# 127.0.0.1:${E2E_SMTP_PORT:-5325} that captures what the backend sends.
#
# Each run creates a new database named atc_pos_e2e_<UTC timestamp> on the dev
# Postgres and never drops anything: the dev database, the _test database and
# earlier runs are left exactly as they were, so a failing run can be
# inspected afterwards. Seed passwords are generated per run and live only in
# this process's environment.
#
# The captured mail is left behind too, under .devlogs/e2e-maildrop-<run>/.
# Each file is 0600 and holds an 8-digit code that was already spent by the
# harness; treat the folder as spent credentials and delete old runs.
#
# Needs the dev stack's Postgres (`docker compose up -d`). Never run this on
# the production host: it writes orders, payments, refunds and a day closing.
set -euo pipefail
[ "$(hostname)" != atc-noc ] || { echo "REFUSED: atc-noc runs production"; exit 1; }
cd "$(dirname "$0")/.."

RUN=$(date -u +%Y%m%d%H%M%S)
DB="atc_pos_e2e_$RUN"
PORT="${E2E_PORT:-5011}"
SMTP="${E2E_SMTP_PORT:-5325}"
if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "port $PORT is already serving something; set E2E_PORT"; exit 1
fi
# The harness seats its staff from codes it reads out of this folder, so a
# second run must not find the first run's mail sitting in it.
MAILDIR="$PWD/.devlogs/e2e-maildrop-$RUN"

docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -qc "CREATE DATABASE $DB OWNER atc_pos"
# Read the password out of the container that just answered, rather than
# keeping a copy here: this file is committed, that environment is not.
PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || { echo "FAIL: could not read POSTGRES_PASSWORD from atc-pos-dev-db"; exit 1; }
URL="postgresql://atc_pos:${PW}@127.0.0.1:5439/$DB?schema=public"
unset PW
SECRET=$(openssl rand -hex 32)
pw() { openssl rand -hex 12; }
export POS_SEED_ADMIN_PASSWORD="$(pw)" POS_SEED_OWNER_PASSWORD="$(pw)"
export POS_SEED_MANAGER_PASSWORD="$(pw)" POS_SEED_CASHIER_PASSWORD="$(pw)"
export POS_SEED_ALLOW_FIXED_PASSWORDS=true

mkdir -p .devlogs "$MAILDIR"

# Staff accounts are created with a credential no string satisfies and opened
# by a code mailed to the person, so the harness needs a mailbox it can read.
# This sink relays nothing: it accepts the SMTP conversation and drops each
# message in $MAILDIR as .eml. It must be listening BEFORE the backend starts,
# because config/env.js decides once at load whether mail is configured at all.
MAIL_SINK_PORT="$SMTP" MAIL_SINK_DIR="$MAILDIR" \
  node backend/scripts/mail-sink.mjs > ".devlogs/e2e-mailsink-$RUN.log" 2>&1 &
SINK=$!
trap 'kill "$SINK" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  grep -q "listening" ".devlogs/e2e-mailsink-$RUN.log" 2>/dev/null && break
  sleep 0.25
done
grep -q "listening" ".devlogs/e2e-mailsink-$RUN.log" 2>/dev/null || {
  echo "FAIL: mail sink did not start on 127.0.0.1:$SMTP — see .devlogs/e2e-mailsink-$RUN.log"
  echo "      set E2E_SMTP_PORT if something else holds that port"; exit 1; }

cd backend
DATABASE_URL="$URL" npx prisma migrate deploy > "../.devlogs/e2e-migrate-$RUN.log" 2>&1
DATABASE_URL="$URL" POS_JWT_SECRET="$SECRET" node prisma/seed.js > /dev/null
# SMTP_SECURITY=none is accepted here only because NODE_ENV is development; the
# config refuses it in production rather than put a password on the wire. The
# allow-list is not decoration either — outside production the config refuses to
# boot with mail configured and no allow-list, so a stray real address in a
# throwaway database cannot be posted a live code.
DATABASE_URL="$URL" POS_JWT_SECRET="$SECRET" HOST=127.0.0.1 PORT="$PORT" \
  SMTP_HOST=127.0.0.1 SMTP_PORT="$SMTP" SMTP_SECURITY=none \
  MAIL_FROM='VEXO Connect <no-reply@e2e.invalid>' \
  MAIL_ALLOWED_RECIPIENTS='*@atcpos.example' \
  APP_URL="http://127.0.0.1:$PORT" \
  node src/index.js > "../.devlogs/e2e-backend-$RUN.log" 2>&1 &
BACKEND=$!
trap 'kill "$BACKEND" "$SINK" 2>/dev/null || true' EXIT
cd ..

for _ in $(seq 1 30); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done

echo "database $DB, backend 127.0.0.1:$PORT, mail sink 127.0.0.1:$SMTP → $MAILDIR"
E2E_BASE="http://127.0.0.1:$PORT/api" E2E_DB="$DB" E2E_MAILDIR="$MAILDIR" node deploy/e2e-workflow.mjs
