#!/bin/bash
# Preflight: do the stored sandbox credentials actually work against Razorpay?
#
# WHY THIS EXISTS
#
# "Credentials are stored" and "credentials are correct" are different claims,
# and only the second one matters. A typo in the key secret is invisible until
# the first checkout, where it surfaces as a failed payment intent in front of
# whoever is doing the demo. This asks Razorpay directly, before any of that.
#
# It is READ-ONLY. It lists payments with count=1 and looks at nothing but the
# HTTP status. No order is created, no charge is made, no money moves. Running
# it changes nothing at Razorpay and nothing in this repository.
#
# WHAT IT WILL NOT DO
#
# It never prints a secret and never prints a response body. The body of a 200
# is real payment data and the body of a 401 quotes the key id back — neither
# belongs in a transcript. The output is a status code and a verdict.
#
# The key and secret never reach argv. They are piped into curl's config
# parser on stdin, so they are not in /proc/<pid>/cmdline for the life of the
# request, not in the shell history, and not on disk anywhere but the 0600
# file they came from. `printf` is a shell builtin, so the pipe's writing half
# is this process too — there is no second command holding the values.

set -uo pipefail
umask 077

REPO=/home/atc-noc/atc-pos
SECRETS="$REPO/backend/.secrets/razorpay-sandbox.env"
API=https://api.razorpay.com/v1/payments?count=1

fail() { echo "FAIL: $1"; exit 2; }

[ -f "$SECRETS" ] || fail "no stored credentials at $SECRETS — run backend/scripts/razorpay-sandbox-setup.sh first"

PERM="$(stat -c '%a' "$SECRETS")"
[ "$PERM" = "600" ] || fail "$SECRETS is mode $PERM, expected 600 — fix it before using it"
git -C "$REPO" check-ignore -q "$SECRETS" || fail "$SECRETS is visible to git — do not use it while that is true"

# shellcheck source=/dev/null
. "$SECRETS"
KEY_ID="${POS_GATEWAY_KEY_ID:-}"
KEY_SECRET="${POS_GATEWAY_KEY_SECRET:-}"
[ -n "$KEY_ID" ] && [ -n "$KEY_SECRET" ] || fail "stored credentials are incomplete"

case "$KEY_ID" in
  *_live_*)   fail "that is a LIVE key; this script talks to sandbox accounts only" ;;
  rzp_test_*) : ;;
  *)          fail "key id does not look like a Razorpay test key" ;;
esac
echo "PASS: stored key id is a TEST key, file is 0600 and git-ignored"

# --- ask Razorpay ------------------------------------------------------------
# -K - reads the credential from stdin rather than argv. --max-time bounds a
# hung TLS handshake so this cannot sit forever on a box with no egress.
CODE="$(printf 'user = "%s:%s"\n' "$KEY_ID" "$KEY_SECRET" \
  | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - "$API" 2>/dev/null)"
RC=$?
unset KEY_ID KEY_SECRET POS_GATEWAY_KEY_ID POS_GATEWAY_KEY_SECRET POS_GATEWAY_WEBHOOK_SECRET

if [ "$RC" -ne 0 ] || [ -z "$CODE" ] || [ "$CODE" = "000" ]; then
  echo "FAIL: could not reach api.razorpay.com (curl exit $RC, status ${CODE:-none})"
  echo "       This is a connectivity answer, NOT a verdict on the credentials."
  exit 2
fi

# 200 is the only pass. 401/403 mean the credentials are wrong, which is the
# whole reason to run this before a demo rather than during one.
case "$CODE" in
  200)
    echo "PASS: Razorpay accepted the stored credentials (HTTP 200, read-only list)"
    echo "PASS: outbound connectivity to api.razorpay.com works from this box"
    echo
    echo "This proves the OUTBOUND half only. Webhook delivery is the inbound"
    echo "half and is not tested here — that needs the tunnel and a real event."
    exit 0 ;;
  401|403)
    echo "FAIL: Razorpay rejected the stored credentials (HTTP $CODE)"
    echo "       The key id and secret do not match, or the key was revoked."
    echo "       Re-run backend/scripts/razorpay-sandbox-setup.sh to replace them."
    exit 2 ;;
  *)
    echo "FAIL: unexpected HTTP $CODE from api.razorpay.com"
    echo "       Not a credential verdict. Try again before concluding anything."
    exit 2 ;;
esac
