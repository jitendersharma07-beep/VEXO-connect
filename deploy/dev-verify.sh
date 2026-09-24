#!/usr/bin/env bash
# Full dev-side verification for the POS foundation, in one run:
#   backend install → migrate → seed → vitest suite → frontend install → build.
# Idempotent; safe to re-run. Run as atc-noc from the repo root:
#   bash deploy/dev-verify.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# DEV_DB, TEST_DB and DEV_SECRET are built at the end of step 0, not here: the
# database password is read out of the running container rather than written
# down, so this file carries no credential of its own.

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "0/6  Dev Postgres up + reachable"
docker compose up -d
# Ready means the real database answers a query. pg_isready over the socket
# also says yes to the temporary server the image runs while it initialises a
# fresh volume — before atc_pos exists — so on a cold volume the next step
# failed with 'database "atc_pos" does not exist' and a re-run then passed.
for i in $(seq 1 30); do
  docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -tAc 'SELECT 1' >/dev/null
# The test database exists only if the initdb script ran on first boot;
# create it if the volume predates the script.
docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -tc \
  "SELECT 1 FROM pg_database WHERE datname='atc_pos_test'" | grep -q 1 || \
  docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -c 'CREATE DATABASE atc_pos_test OWNER atc_pos'

# The password lives in the container's environment, which is the only copy
# this script needs. Reading it here — rather than holding a literal — means a
# rotated container password is picked up with no edit, and that this file can
# be committed without carrying a credential.
PW="$(docker exec atc-pos-dev-db printenv POSTGRES_PASSWORD 2>/dev/null)"
[ -n "$PW" ] || { echo "FAIL: could not read POSTGRES_PASSWORD from atc-pos-dev-db"; exit 2; }
DEV_DB="postgresql://atc_pos:${PW}@127.0.0.1:5439/atc_pos?schema=public"
TEST_DB="postgresql://atc_pos:${PW}@127.0.0.1:5439/atc_pos_test?schema=public"
unset PW

# Session-signing secret: whatever the caller exported, else fresh per run.
# A per-run value means dev sessions do not outlive the run, and no shared
# signing key sits in the repo for anyone who reads it to mint tokens with.
DEV_SECRET="${POS_JWT_SECRET:-$(openssl rand -hex 32)}"
[ "${#DEV_SECRET}" -ge 32 ] || { echo "FAIL: POS_JWT_SECRET is set but shorter than 32 characters"; exit 2; }

say "1/6  Backend dependencies"
cd backend
npm install --no-audit --no-fund

say "2/6  Prisma migration (dev DB)"
# Migration SQL is committed (20260920000000_pos_foundation); deploy applies it
# without the interactive/dev shadow-database machinery.
DATABASE_URL="$DEV_DB" npx prisma migrate deploy
DATABASE_URL="$DEV_DB" npx prisma generate

say "3/6  Seed (ATC admin + demo café) — passwords print ONCE below"
DATABASE_URL="$DEV_DB" POS_JWT_SECRET="$DEV_SECRET" node prisma/seed.js

say "4/6  Migrate the _test DB and run the isolation/licensing suite"
DATABASE_URL="$TEST_DB" npx prisma migrate deploy
DATABASE_URL="$TEST_DB" POS_JWT_SECRET="$DEV_SECRET" npm test

say "5/6  Frontend dependencies"
cd ../frontend
npm install --no-audit --no-fund

say "6/6  Frontend production build (base=/pos/)"
VITE_BASE_PATH=/pos/ npm run build
ls -lh dist/index.html

say "Dev verification complete."
