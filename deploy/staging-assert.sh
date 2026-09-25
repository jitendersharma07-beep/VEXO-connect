#!/usr/bin/env bash
# Invariant check for the loopback staging stack.
#
#     bash deploy/staging-assert.sh            # check the built bundle + config
#     bash deploy/staging-assert.sh --live     # also probe the running stack
#
# Exit 0 = every invariant holds. Non-zero = something that a status-code probe
# would have called healthy is broken.
#
# Why this file exists. On 2026-09-25 the staging stack was simultaneously
# (a) serving a /pos/-based bundle from a root-serving edge and (b) running with
# a CORS allow-list that did not include the edge origin. The result was a
# portal that no browser could load or log into — and `curl /`, `curl
# /api/health`, `docker ps` and the runner's own `status` command all reported
# 200/Up throughout. Each check below is one of the things that were true then
# and should never be true again.
#
# It deliberately checks ARTEFACTS, not intentions: it reads the bundle that
# exists on disk, not the variable that was supposed to produce it.

set -uo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
. deploy/staging-local.env.sh

DIST="frontend/dist"
CONF="deploy/staging-edge.conf"
EDGE="http://127.0.0.1:${VCX_STAGING_EDGE_PORT}"
fails=0

if [ -t 1 ]; then G=$'\033[0;32m'; R=$'\033[0;31m'; Z=$'\033[0m'; else G=''; R=''; Z=''; fi
ok()   { printf '  %sPASS%s  %s\n' "$G" "$Z" "$*"; }
bad()  { printf '  %sFAIL%s  %s\n' "$R" "$Z" "$*"; fails=$((fails + 1)); }
note() { printf '        %s\n' "$*"; }

# Read a config as DIRECTIVES, never as prose. The first version of this script
# grepped the whole file and failed on the word "/pos/" inside the explanatory
# header of deploy/staging-edge.conf — and would equally have passed a check for
# "location ^~ /api/" off a comment that merely mentioned it. Both directions of
# that mistake are silent, so comments are stripped once, here.
directives() { sed 's/#.*//' "$1"; }

echo "staging-assert: built bundle"

if [ ! -f "$DIST/index.html" ]; then
  bad "no $DIST/index.html — nothing has been built"
else
  # 1. index.html must reference /assets/..., not /pos/assets/...
  refs="$(grep -o '"/[^"]*/assets/[^"]*"\|src="/assets/[^"]*"\|href="/assets/[^"]*"' "$DIST/index.html" || true)"
  if grep -q '/pos/' "$DIST/index.html"; then
    bad "index.html references /pos/ — built with the PRODUCTION base path"
    note "$(grep -o '/pos/[^\"]*' "$DIST/index.html" | head -2 | tr '\n' ' ')"
    note "rebuild with VITE_BASE_PATH=$VCX_STAGING_BASE_PATH"
  elif [ -n "$refs" ]; then
    ok "index.html references root-based assets"
  else
    bad "index.html references no /assets/ entry point at all"
  fi

  # 2. The bundle's axios baseURL must be /api, not /pos/api. This is the half
  #    that a page-load check cannot see: the SPA can boot and still send every
  #    API call to a path the edge does not proxy.
  entry="$(ls -1 "$DIST"/assets/index-*.js 2>/dev/null | head -1)"
  if [ -z "$entry" ]; then
    bad "no $DIST/assets/index-*.js bundle found"
  else
    base="$(grep -ao 'baseURL:"[^"]*"' "$entry" | head -1)"
    case "$base" in
      'baseURL:"/api"') ok "bundle API base is /api  ($(basename "$entry"))" ;;
      '')               bad "could not find an axios baseURL in $(basename "$entry")" ;;
      *)                bad "bundle API base is ${base#baseURL:} — expected \"/api\"" ;;
    esac
    if grep -aq '"/pos/' "$entry"; then
      bad "bundle still contains /pos/ literals"
    else
      ok "bundle contains no /pos/ literals"
    fi
  fi
fi

echo "staging-assert: edge config"

if [ ! -f "$CONF" ]; then
  bad "missing $CONF"
else
  directives "$CONF" | grep -q 'location \^~ /api/' \
    && ok "edge proxies ^~ /api/ (SPA fallback cannot answer an API path)" \
    || bad "edge has no 'location ^~ /api/' — API calls will fall through to index.html"
  directives "$CONF" | grep -q "proxy_pass http://127.0.0.1:${VCX_STAGING_API_PORT}" \
    && ok "edge proxy target is 127.0.0.1:${VCX_STAGING_API_PORT}" \
    || bad "edge does not proxy to 127.0.0.1:${VCX_STAGING_API_PORT}"
  directives "$CONF" | grep -q '/pos/' \
    && bad "edge config serves under /pos/ — this stack serves at the root" \
    || ok "edge config serves at the root (no /pos/ prefix)"
  directives "$CONF" | grep -q "listen 127.0.0.1:${VCX_STAGING_EDGE_PORT}" \
    && ok "edge listens on 127.0.0.1:${VCX_STAGING_EDGE_PORT} (loopback only)" \
    || bad "edge does not listen on loopback :${VCX_STAGING_EDGE_PORT}"
fi

echo "staging-assert: backend origins"

case "$VCX_STAGING_CORS_ORIGIN" in
  *"127.0.0.1:${VCX_STAGING_EDGE_PORT}"*)
    ok "CORS allow-list contains the edge origin :${VCX_STAGING_EDGE_PORT}" ;;
  *)
    bad "CORS allow-list is missing the edge origin — browser login will 500" ;;
esac
[ "$VCX_STAGING_APP_URL" = "$EDGE" ] \
  && ok "APP_URL is the edge origin" \
  || bad "APP_URL is $VCX_STAGING_APP_URL, expected $EDGE"

if [ "${1:-}" = "--live" ]; then
  echo "staging-assert: running stack"

  # The decisive one. Ask for the entry point exactly as index.html spells it
  # and require JavaScript back. A /pos/-based bundle answers this with
  # text/html and HTTP 200, which is the whole reason a status-code probe
  # missed the outage.
  src="$(curl -fsS "$EDGE/" 2>/dev/null | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)"
  if [ -z "$src" ]; then
    bad "could not read an asset reference from $EDGE/"
  else
    ctype="$(curl -fsS -o /dev/null -w '%{content_type}' "$EDGE$src" 2>/dev/null)"
    case "$ctype" in
      application/javascript*|text/javascript*)
        ok "entry script served as $ctype" ;;
      *)
        bad "entry script $src served as '$ctype' — the SPA will not boot" ;;
    esac
  fi

  htype="$(curl -fsS -o /dev/null -w '%{content_type}' "$EDGE/api/health" 2>/dev/null)"
  case "$htype" in
    application/json*) ok "/api/health proxied, answered as JSON" ;;
    *)                 bad "/api/health answered as '$htype' — not reaching the API" ;;
  esac

  # A same-origin browser POST carries Origin. Replay that, and require the
  # request NOT to be rejected by CORS. Sending no Origin — which is what curl
  # does by default — passes even when the allow-list is wrong, so the header
  # here is the entire point of the check.
  code="$(curl -fsS -o /dev/null -w '%{http_code}' -X POST \
            -H "Origin: $EDGE" -H 'Content-Type: application/json' \
            --data '{"email":"assert@invalid.test","password":"x"}' \
            "$EDGE/api/auth/login" 2>/dev/null || true)"
  case "$code" in
    500|000) bad "login POST with Origin: $EDGE returned $code — CORS allow-list is wrong" ;;
    "")      bad "login POST with Origin: $EDGE produced no status" ;;
    *)       ok "login POST with Origin: $EDGE reached the handler (HTTP $code, bad creds expected)" ;;
  esac
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "staging-assert: OK"
  exit 0
fi
echo "staging-assert: $fails FAILED"
exit 1
