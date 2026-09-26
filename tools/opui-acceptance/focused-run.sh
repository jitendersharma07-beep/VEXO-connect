#!/usr/bin/env bash
# Focused verification of a named SHA's test files, on a private database, from
# an immutable snapshot. Sibling of vexo-connect-x-tools/certify-candidate.sh and
# deliberately NOT a replacement for it: this runs a named subset, so it can
# never answer "is the candidate green" — only "does this file do what its commit
# message claims".
#
#   usage:  focused-run.sh <sha> <label> <test-file> [<test-file> ...]
#
# Four things it will not let me get wrong, because each has already cost this
# program a result:
#
#   1. HEAD moving under the run.  `git archive` into a directory that is not a
#      git checkout, so nothing can commit into it and no peer's working-tree
#      edit can reach it. This matters more than usual here: the tree that holds
#      the code under test (vexo-connect-x-lanes/experience) has NINE uncommitted
#      files belonging to another window right now.
#   2. Skips read as passes.  A file whose top-level beforeAll throws reports
#      every test in it as SKIPPED, and vitest exits 0 on skips in some shapes.
#      `7969764` exists precisely because that happened to this file. So the
#      skipped count is asserted, not eyeballed.
#   3. A shared database.  Private DB named after the label, dropped and
#      recreated, migration count logged.
#   4. Evidence in /tmp.  Durable log under .runlogs, md5 recorded.
#
# It records the box's contention rather than gating on a quiet box: ~24 sessions
# launch runs here continuously and waiting for silence is unreachable.
#
# Never touches production, vexo-lab, or any database not named vcx_*_test.
set -uo pipefail

if [ "$(hostname)" != "atc-noc" ]; then
  echo "focused-run: refusing — this runner is for atc-noc only (got: $(hostname))"
  exit 1
fi

SHA_IN="${1:-}"
LABEL="${2:-}"
shift 2 2>/dev/null || true
[ -n "$SHA_IN" ] && [ -n "$LABEL" ] && [ $# -ge 1 ] || {
  echo "usage: $0 <sha> <label> <test-file> [<test-file> ...]" >&2
  exit 64
}

GITDIR=/home/atc-noc/vexo-connect-x
DEPS=/home/atc-noc/vexo-connect-x-lanes/main-merge
BASE=/home/atc-noc/vcx-opui-local
LOGDIR="$BASE/.runlogs"
DBC=vexo-connect-dev-db

SHA=$(env -u GIT_INDEX_FILE git -C "$GITDIR" rev-parse "$SHA_IN" 2>/dev/null) || {
  echo "focused-run: unknown rev $SHA_IN" >&2
  exit 64
}
SHORT=$(env -u GIT_INDEX_FILE git -C "$GITDIR" rev-parse --short "$SHA")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAP="$BASE/snap-$LABEL-$SHORT-$STAMP"
LOG="$LOGDIR/focused-$LABEL-$SHORT-$STAMP.log"
DB="vcx_opui_${LABEL}_test" # globalSetup.js requires the _test suffix

case "$DB" in
vcx_opui_*_test) : ;;
*)
  echo "focused-run: computed database name '$DB' is not vcx_opui_<label>_test — refusing" >&2
  exit 1
  ;;
esac

mkdir -p "$LOGDIR" "$SNAP"
say() { echo "$@" | tee -a "$LOG"; }
redact() { sed -E 's#://[^:]+:[^@]+@#://USER:****@#'; }

{
  echo "=============================================================="
  echo " focused verification run"
  echo "=============================================================="
  echo "sha:             $SHA"
  echo "tree:            $(env -u GIT_INDEX_FILE git -C "$GITDIR" rev-parse "$SHA^{tree}")"
  echo "subject:         $(env -u GIT_INDEX_FILE git -C "$GITDIR" log -1 --format=%s "$SHA")"
  echo "files under test: $*"
  echo "snapshot:        $SNAP"
  echo "database:        $DB @ 127.0.0.1:5440"
  echo "started_utc:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "loadavg_start:   $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "peer_vitest:     $(pgrep -fc 'node .*vitest' 2>/dev/null || echo 0) vitest processes on the box"
} >"$LOG"

# Dependency reuse is only valid while the manifests match. Assert, never assume.
say ""
say "== manifest identity (dependency reuse is only valid if these match) =="
for f in backend/package.json backend/package-lock.json; do
  a=$(env -u GIT_INDEX_FILE git -C "$GITDIR" rev-parse "$SHA:$f")
  b=$(env -u GIT_INDEX_FILE git -C "$GITDIR" hash-object "$DEPS/$f")
  if [ "$a" != "$b" ]; then
    say "ABORT: $f differs from the tree whose node_modules this run borrows"
    exit 1
  fi
  say "same: $f"
done

say ""
say "== immutable snapshot (git archive — not a checkout) =="
env -u GIT_INDEX_FILE git -C "$GITDIR" archive "$SHA" | tar -x -C "$SNAP" || {
  say "ABORT: archive failed"
  exit 1
}
say "files extracted: $(find "$SNAP" -type f | wc -l)"

# Copied, never symlinked: `prisma generate` writes node_modules/.prisma, and a
# symlink would mutate the shared worktree's client under every other session.
say "copying node_modules (real copy, not a symlink) ..."
cp -r "$DEPS/backend/node_modules" "$SNAP/backend/node_modules" || {
  say "ABORT: dep copy failed"
  exit 1
}

cd "$SNAP/backend" || exit 1

PGPW="$(docker exec "$DBC" printenv POSTGRES_PASSWORD)"
[ -n "${PGPW:-}" ] || {
  say "ABORT: could not read the dev database password"
  exit 1
}
export DATABASE_URL="postgresql://vexo_dev:${PGPW}@127.0.0.1:5440/${DB}?schema=public"
export POS_JWT_SECRET="$(openssl rand -hex 32)"
export NODE_ENV=test
export LOG_LEVEL=silent

say ""
say "== database (private, recreated) =="
docker exec "$DBC" psql -U vexo_dev -d postgres -c "DROP DATABASE IF EXISTS $DB" 2>&1 | redact >>"$LOG"
docker exec "$DBC" psql -U vexo_dev -d postgres -c "CREATE DATABASE $DB OWNER vexo_dev" 2>&1 | redact >>"$LOG"

say ""
say "== prisma generate (from the snapshot's own schema) =="
npx prisma generate 2>&1 | redact >>"$LOG"
say "schema models:      $(grep -c '^model ' prisma/schema.prisma)"

say ""
say "== migrate deploy =="
npx prisma migrate deploy 2>&1 | redact >>"$LOG"
say "migrations on disk: $(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l)"
say "migrations applied: $(docker exec "$DBC" psql -U vexo_dev -d "$DB" -tAc \
  'select count(*) from "_prisma_migrations" where finished_at is not null' 2>/dev/null)"

say ""
say "== vitest =="
say "cmd: npx vitest run $*"
START=$(date -u +%s)
npx vitest run "$@" 2>&1 | redact | tee -a "$LOG"
RC=${PIPESTATUS[0]}
END=$(date -u +%s)

# --- verdict -----------------------------------------------------------------
# Parsed from the log, because the three numbers that decide this are on
# different lines and a human reading only the last one has twice been wrong.
SUM=$(grep -E '^\s+Tests\s+' "$LOG" | tail -1)
FILES=$(grep -E '^\s+Test Files\s+' "$LOG" | tail -1)
SKIPPED=$(printf '%s' "$SUM" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+' || echo 0)
FAILED=$(printf '%s' "$SUM" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)
PASSED=$(printf '%s' "$SUM" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)

{
  echo ""
  echo "=============================================================="
  echo " VERDICT"
  echo "=============================================================="
  echo "sha:             $SHA"
  echo "files:           $FILES"
  echo "tests:           $SUM"
  echo "passed:          $PASSED"
  echo "failed:          $FAILED"
  echo "skipped:         $SKIPPED"
  echo "exit_code:       $RC"
  echo "duration_s:      $((END - START))"
  echo "loadavg_end:     $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "finished_utc:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee -a "$LOG"

VERDICT=GREEN
[ "$RC" = "0" ] || VERDICT=RED
[ "$FAILED" = "0" ] || VERDICT=RED
# A skip is not a pass. 7969764 exists because 35 skipped tests read as green.
[ "$SKIPPED" = "0" ] || VERDICT="RED (skips present — a skipped file asserts nothing)"
[ "$PASSED" != "0" ] || VERDICT="RED (nothing ran)"

echo "verdict:         $VERDICT" | tee -a "$LOG"
echo "log:             $LOG" | tee -a "$LOG"
echo "log_md5:         $(md5sum "$LOG" | cut -d' ' -f1)" | tee -a "$LOG"
echo ""
echo "snapshot kept at $SNAP (delete by hand when the evidence is no longer needed)"

case "$VERDICT" in GREEN) exit 0 ;; *) exit 1 ;; esac
