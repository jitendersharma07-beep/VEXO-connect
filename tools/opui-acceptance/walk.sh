#!/usr/bin/env bash
# Run a tests/e2e browser walk against THIS lane's stack.
#
# The walks were written for the shared dev stack (:5177 + POS_SEED_* env), and
# this lane runs its own API/Vite pair on 5571/5671 with its own seed passwords
# under VCX_OPUI_SEED_*. This maps one onto the other and nothing else — the
# walk scripts themselves are repo-owned and are not edited to suit the lane.
#
# Passwords are sourced, never echoed. `set -a` + `source` keeps them out of the
# process list, which an inline `POS_SEED_X=... node` would not.
#
#   usage: ./walk.sh walk-promotions.cjs [more-args]
set -euo pipefail

BASE=/home/atc-noc/vcx-opui-local
WT=/home/atc-noc/vexo-connect-x-lanes/operator-ui
SCRIPT="${1:?usage: walk.sh <script.cjs>}"
shift || true

if [ ! -f "$WT/tests/e2e/$SCRIPT" ]; then
  echo "walk.sh: no such walk: tests/e2e/$SCRIPT"
  exit 2
fi

set -a
# shellcheck disable=SC1091
source "$BASE/.seedpasswords"
set +a

export POS_SEED_ADMIN_PASSWORD="${VCX_OPUI_SEED_ADMIN:-}"
export POS_SEED_OWNER_PASSWORD="${VCX_OPUI_SEED_OWNER:-}"
export POS_SEED_MANAGER_PASSWORD="${VCX_OPUI_SEED_MANAGER:-}"
export POS_SEED_CASHIER_PASSWORD="${VCX_OPUI_SEED_CASHIER:-}"

export POS_E2E_BASE="${POS_E2E_BASE:-http://127.0.0.1:5671}"
export POS_E2E_SHOTS="${POS_E2E_SHOTS:-/tmp/vcx-opui-shots}"
# No node_modules at the lane repo root, and the lane may not install one: the
# walks' own env.cjs supports being pointed at a playwright-core elsewhere.
#
# The version pairing matters and is not free choice. Only chromium-1117 is in
# this box's browser cache; playwright-core 1.56.1 wants build 1194 and 1.49.1
# wants 1148, and neither is downloadable here. So we use 1.49.1 — the closest
# core to what is cached — and hand it the 1117 binary through env.cjs's
# POS_E2E_CHROMIUM fallback, which exists for exactly this case.
export POS_E2E_PLAYWRIGHT="${POS_E2E_PLAYWRIGHT:-/home/atc-noc/.npm/_npx/f0a362733743bae2/node_modules/playwright-core}"
export POS_E2E_CHROMIUM="${POS_E2E_CHROMIUM:-/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome}"

# Refuse rather than walk a dead stack: a walk against a stopped Vite fails
# every step for one reason and reads like twelve separate defects.
for url in "$POS_E2E_BASE" "$POS_E2E_BASE/api/health"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo 000)
  case "$code" in
    2*|3*) ;;
    *) echo "walk.sh: $url answered $code — run \`vcxo up\` first"; exit 3 ;;
  esac
done

mkdir -p "$POS_E2E_SHOTS"
cd "$WT"
exec node "tests/e2e/$SCRIPT" "$@"
