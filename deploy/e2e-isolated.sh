#!/usr/bin/env bash
# Runs deploy/e2e-workflow.mjs against a FRESH database, served by its own
# backend on 127.0.0.1:${E2E_PORT:-5011}.
#
# Each run creates a new database named atc_pos_e2e_<UTC timestamp> on the dev
# Postgres and never drops anything: the dev database, the _test database and
# earlier runs are left exactly as they were, so a failing run can be
# inspected afterwards. Seed passwords are generated per run and live only in
# this process's environment.
#
# Needs the dev stack's Postgres (`docker compose up -d`). Never run this on
# the production host: it writes orders, payments, refunds and a day closing.
set -euo pipefail
[ "$(hostname)" != atc-noc ] || { echo "REFUSED: atc-noc runs production"; exit 1; }
cd "$(dirname "$0")/.."

RUN=$(date -u +%Y%m%d%H%M%S)
DB="atc_pos_e2e_$RUN"
PORT="${E2E_PORT:-5011}"
if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "port $PORT is already serving something; set E2E_PORT"; exit 1
fi

docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -qc "CREATE DATABASE $DB OWNER atc_pos"
URL="postgresql://atc_pos:atc_pos_dev@127.0.0.1:5439/$DB?schema=public"
SECRET=$(openssl rand -hex 32)
pw() { openssl rand -hex 12; }
export POS_SEED_ADMIN_PASSWORD="$(pw)" POS_SEED_OWNER_PASSWORD="$(pw)"
export POS_SEED_MANAGER_PASSWORD="$(pw)" POS_SEED_CASHIER_PASSWORD="$(pw)"
export POS_SEED_ALLOW_FIXED_PASSWORDS=true

mkdir -p .devlogs
cd backend
DATABASE_URL="$URL" npx prisma migrate deploy > "../.devlogs/e2e-migrate-$RUN.log" 2>&1
DATABASE_URL="$URL" POS_JWT_SECRET="$SECRET" node prisma/seed.js > /dev/null
DATABASE_URL="$URL" POS_JWT_SECRET="$SECRET" HOST=127.0.0.1 PORT="$PORT" \
  node src/index.js > "../.devlogs/e2e-backend-$RUN.log" 2>&1 &
BACKEND=$!
trap 'kill "$BACKEND" 2>/dev/null || true' EXIT
cd ..

for _ in $(seq 1 30); do
  curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done

echo "database $DB, backend 127.0.0.1:$PORT"
E2E_BASE="http://127.0.0.1:$PORT/api" E2E_DB="$DB" node deploy/e2e-workflow.mjs
