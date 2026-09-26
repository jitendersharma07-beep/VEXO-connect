#!/usr/bin/env bash
# Runner for the LOOPBACK staging stack. This is the whole implementation; the
# operator's `vcxcr` is a three-line wrapper that execs this file.
#
#     bash deploy/staging-run.sh {setup|migrate|testmigrate|seed|test|migsql|build|edge|up|down|status}
#
# Why it lives in the repo. Until 2026-09-25 the runner was a single unversioned
# file in the operator's home directory. Three behaviours that the staging stack
# depends on existed ONLY there: the pinned frontend base path, the post-build
# invariant check, and the two backend origin variables. A fresh checkout
# reproduced none of them, and losing or overwriting that one file would have
# taken all three with it — silently, because the failure mode is a portal that
# answers 200 to every probe and renders nothing. Config that a deployment
# cannot boot correctly without is infrastructure, so it is versioned and
# reviewed like infrastructure.
#
# Isolation contract (nothing shared is written):
#   - Databases: vcx_staging, vcx_staging_test, vcx_staging_shadow ONLY, on the
#     existing vexo-connect-dev Postgres container (loopback 127.0.0.1:5440).
#     Production (pos-prod-postgres-1) is never named here and has no host port.
#   - node_modules: per-entry SYMLINK overlay over the x/foundation lane's
#     installed trees, with @prisma/client and .prisma as REAL copies so
#     `prisma generate` writes inside THIS lane and never through a symlink
#     into a peer's tree. Same for the frontend's node_modules/.vite cache.
#   - No npm install / npm ci anywhere.
#
# NO CREDENTIALS ARE IN THIS FILE. The dev database password is read out of the
# running container at run time and never written to disk or echoed; the JWT
# secret lives in an untracked mode-600 file beside the operator's wrapper.
set -euo pipefail

# Host guard. Deliberately kept and deliberately not overridable: this runner
# names a specific Postgres container and a specific peer lane, and on any other
# machine those names either do not exist or belong to something else.
if [ "$(hostname)" != "atc-noc" ]; then
  echo "staging-run: refusing — atc-noc only (got: $(hostname))"
  exit 1
fi

# The worktree is wherever THIS file is, so a second checkout runs against
# itself rather than against whatever path was hardcoded when it was written.
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Two host-specific paths that cannot be derived. Overridable so a second
# checkout can point at its own, with this box's values as the defaults.
#   SRC  — the lane whose installed node_modules are overlaid (never written to)
#   BASE — untracked local state: .secret, .pw-* and .runlogs. NOT in the repo
#          and must never be, which is exactly why it is a variable and not a
#          directory inside the worktree.
SRC="${VCX_STAGING_SRC_LANE:-/home/atc-noc/vexo-connect-x-lanes/foundation}"
BASE="${VCX_STAGING_LOCAL_DIR:-/home/atc-noc/vcx-cloudready-local}"

LOGDIR="$BASE/.runlogs"
DBC=vexo-connect-dev-db
DBUSER=vexo_dev
DBHOST=127.0.0.1
DBPORT=5440

# Topology, base path and origins come from the file next door, so the reasoning
# sits beside the nginx config it is paired with. That file carries no
# credentials either.
# shellcheck disable=SC1091
. "$WT/deploy/staging-local.env.sh"
API_PORT="$VCX_STAGING_API_PORT"
WEB_PORT="$VCX_STAGING_WEB_PORT"
EDGE_PORT="$VCX_STAGING_EDGE_PORT"
EDGE_NAME="$VCX_STAGING_EDGE_NAME"
EDGE_IMAGE="$VCX_STAGING_EDGE_IMAGE"

[ -d "$WT/backend" ] || { echo "staging-run: worktree missing at $WT"; exit 1; }
mkdir -p "$LOGDIR"

usage() {
  echo "usage: vcxcr {setup|migrate|testmigrate|seed|test|migsql|build|edge|up|down|status}"
  exit 2
}
[ $# -ge 1 ] || usage
cmd="$1"

db_pw() {
  docker exec "$DBC" printenv POSTGRES_PASSWORD
}

load_env() {
  local pw
  pw="$(db_pw)"
  export DATABASE_URL="postgresql://${DBUSER}:${pw}@${DBHOST}:${DBPORT}/vcx_staging"
  export TEST_DATABASE_URL="postgresql://${DBUSER}:${pw}@${DBHOST}:${DBPORT}/vcx_staging_test"
  export SHADOW_DATABASE_URL="postgresql://${DBUSER}:${pw}@${DBHOST}:${DBPORT}/vcx_staging_shadow"
  if [ -f "$BASE/.secret" ]; then
    # shellcheck disable=SC1091
    . "$BASE/.secret"
  fi
  export PORT="$API_PORT"
  export HOST=127.0.0.1
  # Both of these come from deploy/staging-local.env.sh, which explains why the
  # edge origin has to appear in each of them. They default to the loopback edge
  # and a caller MAY override them — publishing this stack on a real hostname is
  # impossible otherwise. What makes that safe is staging-assert.sh rather than
  # the value being unassignable: it refuses a CORS allow-list that has dropped
  # the edge origin, which is the mistake that produces a 500 only a browser can
  # see. An earlier version of this comment claimed they were not overridable;
  # they were not, and the result was that COOKIE_SECURE alone took effect and
  # the published stack set a Secure cookie for a 127.0.0.1 APP_URL.
  export APP_URL="$VCX_STAGING_APP_URL"
  export CORS_ORIGIN="$VCX_STAGING_CORS_ORIGIN"
  export LOG_LEVEL="${LOG_LEVEL:-info}"
}

overlay() {
  local src="$1" dst="$2" p n s skipme
  shift 2
  mkdir -p "$dst"
  for p in "$src"/* "$src"/.[!.]*; do
    [ -e "$p" ] || continue
    n="${p##*/}"
    skipme=0
    for s in "$@"; do
      if [ "$n" = "$s" ]; then skipme=1; fi
    done
    [ "$skipme" = 1 ] && continue
    [ -e "$dst/$n" ] && continue
    ln -s "$p" "$dst/$n"
  done
}

case "$cmd" in
  setup)
    [ -d "$SRC/backend/node_modules" ] || { echo "staging-run: source node_modules missing at $SRC"; exit 1; }
    overlay "$SRC/backend/node_modules" "$WT/backend/node_modules" '@prisma' '.prisma' '.bin'
    mkdir -p "$WT/backend/node_modules/.bin"
    overlay "$SRC/backend/node_modules/.bin" "$WT/backend/node_modules/.bin"
    if [ ! -d "$WT/backend/node_modules/@prisma" ]; then
      cp -R "$SRC/backend/node_modules/@prisma" "$WT/backend/node_modules/@prisma"
    fi
    overlay "$SRC/frontend/node_modules" "$WT/frontend/node_modules" '.vite' '.bin'
    mkdir -p "$WT/frontend/node_modules/.bin" "$WT/frontend/node_modules/.vite"
    overlay "$SRC/frontend/node_modules/.bin" "$WT/frontend/node_modules/.bin"
    if [ ! -f "$BASE/.secret" ]; then
      umask 077
      { echo "export POS_JWT_SECRET=$(openssl rand -hex 32)"; } > "$BASE/.secret"
    fi
    load_env
    ( cd "$WT/backend" && npx --no-install prisma generate >/dev/null 2>&1 ) || {
      echo "staging-run: prisma generate FAILED"; exit 1; }
    echo "staging-run setup: OK"
    ;;
  migrate)
    load_env
    cd "$WT/backend"
    npx --no-install prisma migrate deploy
    ;;
  seed)
    load_env
    cd "$WT/backend"
    node prisma/seed.js
    ;;
  testmigrate)
    # The suites run against vcx_staging_test, which `migrate` does not touch.
    # Left empty it produces 17 red files all saying "table does not exist",
    # which reads as a regression and is not one.
    load_env
    cd "$WT/backend"
    DATABASE_URL="$TEST_DATABASE_URL" npx --no-install prisma migrate deploy
    ;;
  test)
    load_env
    cd "$WT/backend"
    shift || true
    DATABASE_URL="$TEST_DATABASE_URL" NODE_ENV=test npx --no-install vitest run "$@"
    ;;
  migsql)
    load_env
    cd "$WT/backend"
    npx --no-install prisma migrate diff \
      --from-migrations prisma/migrations \
      --to-schema-datamodel prisma/schema.prisma \
      --shadow-database-url "$SHADOW_DATABASE_URL" \
      --script
    ;;
  build)
    load_env
    # PINNED, not defaulted. This used to be "${VITE_BASE_PATH:-/}", which let an
    # exported VITE_BASE_PATH=/pos/ in the caller's shell silently produce a
    # bundle this edge cannot serve — a blank page that answers 200 to every
    # probe. That is how 2026-09-24's build went wrong. If you genuinely want a
    # /pos/ bundle, build the production image; this runner only builds staging.
    if [ -n "${VITE_BASE_PATH:-}" ] && [ "$VITE_BASE_PATH" != "$VCX_STAGING_BASE_PATH" ]; then
      echo "staging-run build: ignoring VITE_BASE_PATH=$VITE_BASE_PATH — staging is pinned to $VCX_STAGING_BASE_PATH"
    fi
    ( cd "$WT/frontend" && VITE_BASE_PATH="$VCX_STAGING_BASE_PATH" npx --no-install vite build </dev/null )
    # Check the artefact that was actually produced, not the variable that was
    # supposed to produce it, and refuse to call a bad build a success.
    bash "$WT/deploy/staging-assert.sh" || {
      echo "staging-run build: FAILED its own invariants — see above. Not usable."; exit 1; }
    ;;
  edge)
    # Recreate the nginx edge FROM THE REPO. Until 2026-09-25 this container was
    # a hand-built object: created once by hand, bind-mounting a loose copy of
    # the nginx config out of the operator's home. Nothing recreated it if it was
    # removed, and that copy could drift from the reviewed one without anything
    # noticing — deploy/staging-assert.sh was reading the repo file while nginx
    # read the other one.
    #
    # --network host is required: the edge must reach the API on 127.0.0.1 in the
    # host's namespace, and the config binds its listener to 127.0.0.1 so host
    # networking does not put it on the public interface.
    #
    # Rollback: the previous config is kept as staging-edge.conf.rollback beside
    # the wrapper, and re-running this command against a reverted repo file
    # restores it. The container is disposable; the bundle and the database are
    # not touched here.
    [ -f "$WT/deploy/staging-edge.conf" ] || {
      echo "staging-run edge: missing $WT/deploy/staging-edge.conf"; exit 1; }
    [ -f "$WT/frontend/dist/index.html" ] || {
      echo "staging-run edge: no built bundle to serve — run 'build' first"; exit 1; }
    docker rm -f "$EDGE_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$EDGE_NAME" --network host \
      -v "$WT/deploy/staging-edge.conf:/etc/nginx/conf.d/default.conf:ro" \
      -v "$WT/frontend/dist:/usr/share/nginx/html:ro" \
      "$EDGE_IMAGE" >/dev/null
    sleep 1
    docker ps --filter "name=$EDGE_NAME" --format 'staging-run edge: {{.Names}} {{.Status}}'
    ;;
  up)
    load_env
    cd "$WT/backend"
    nohup node src/index.js > "$LOGDIR/api.log" 2>&1 &
    echo $! > "$LOGDIR/api.pid"
    sleep 2
    cd "$WT/frontend"
    nohup npx --no-install vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
      > "$LOGDIR/web.log" 2>&1 &
    echo $! > "$LOGDIR/web.pid"
    sleep 2
    echo "staging-run up: api=$(cat "$LOGDIR/api.pid") web=$(cat "$LOGDIR/web.pid")"
    ;;
  down)
    for f in api web; do
      if [ -f "$LOGDIR/$f.pid" ]; then
        pid="$(cat "$LOGDIR/$f.pid")"
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
        rm -f "$LOGDIR/$f.pid"
      fi
    done
    echo "staging-run down: OK"
    ;;
  status)
    curl -s -o /dev/null -w "api  %{http_code}\n" "http://127.0.0.1:${API_PORT}/api/health" || echo "api  DOWN"
    curl -s -o /dev/null -w "web  %{http_code}\n" "http://127.0.0.1:${WEB_PORT}/" || echo "web  DOWN"
    curl -s -o /dev/null -w "edge %{http_code}\n" "http://127.0.0.1:${EDGE_PORT}/" || echo "edge DOWN"
    # A status code says nothing about whether this stack is usable — that is the
    # entire lesson of 2026-09-25, when every one of the lines above read 200
    # against a portal no browser could load. Point at the real check.
    echo "(status codes only — run 'bash $WT/deploy/staging-assert.sh --live' for the invariants)"
    ;;
  *)
    usage
    ;;
esac
