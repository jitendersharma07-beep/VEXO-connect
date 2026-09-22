#!/bin/bash
# Answer one question: is the key id in the Razorpay dashboard you are looking
# at the same one this backend is configured with?
#
# "Account mismatch" has been a hypothesis for a while — the dashboard shows no
# payments, and one explanation is that the dashboard and the backend are two
# different Razorpay accounts. That is cheap to settle and expensive to leave
# open, because every later result is read differently depending on the answer.
#
# The obvious way to settle it is to print the configured key id and eyeball it.
# We do not do that. Scrollback gets pasted into chats, so anything printed here
# should be assumed public later. Instead the value comes IN, hidden, and only a
# verdict goes OUT.
#
# Prints MATCH or NO MATCH. Nothing else about either value.

set -uo pipefail
umask 077

REPO=/home/atc-noc/atc-pos
SECRETS="$REPO/backend/.secrets/razorpay-sandbox.env"

fail() { echo "FAIL: $1"; exit 2; }

[ -f "$SECRETS" ] || fail "no stored credentials at backend/.secrets/razorpay-sandbox.env"
[ "$(stat -c '%a' "$SECRETS")" = "600" ] || fail "credential file is not 0600"

# Typing blind needs a real terminal. Through a pipe the prompt would be
# invisible and the input would echo into the transcript, which is the one
# outcome this script exists to prevent.
[ -t 0 ] || [ -r /dev/tty ] || fail "run this in a terminal — it reads hidden input"

# shellcheck source=/dev/null
. "$SECRETS"

STORED="${POS_GATEWAY_KEY_ID:-}"
[ -n "$STORED" ] || fail "POS_GATEWAY_KEY_ID is not set in the credential file"

# A live key must never be in play here, and that is worth refusing over even
# though it costs one bit about the stored value. The bit is a safety property,
# not the key.
case "$STORED" in
  *_live_*) fail "stored key is a LIVE key; refusing to run sandbox checks against it" ;;
  rzp_test_*) : ;;
  *) fail "stored key is not in rzp_test_ form" ;;
esac

echo "Paste the Key Id from the Razorpay dashboard you are looking at."
echo "(Settings -> API Keys, the rzp_test_... value. Input is hidden.)"
printf 'Key Id: '

# Echo off for the read, and restored however this exits — including Ctrl-C,
# otherwise the terminal is left silently swallowing keystrokes.
SAVED="$(stty -g 2>/dev/null)"
restore() { [ -n "${SAVED:-}" ] && stty "$SAVED" 2>/dev/null; }
trap 'restore; echo; exit 130' INT TERM
stty -echo 2>/dev/null

TYPED=''
IFS= read -r TYPED < /dev/tty
rc=$?

restore
trap - INT TERM
echo

[ $rc -eq 0 ] || fail "no input read"

# Pasting from a browser or a Windows-side notepad drags in a carriage return
# and spaces. Those are transport noise, not part of the key, and tripping on
# them would report a mismatch that is not real.
TYPED="${TYPED%$'\r'}"
TYPED="${TYPED#"${TYPED%%[![:space:]]*}"}"
TYPED="${TYPED%"${TYPED##*[![:space:]]}"}"

[ -n "$TYPED" ] || fail "nothing was entered"

if [ "$TYPED" = "$STORED" ]; then
  echo "MATCH"
  echo "  The dashboard you are looking at is the account this backend uses."
  rc=0
else
  echo "NO MATCH"
  # This line describes only what YOU just typed, which you can already read off
  # your own dashboard. It says nothing about the stored value.
  case "$TYPED" in
    rzp_live_*) echo "  The value you pasted is a LIVE key. Switch the dashboard to Test Mode." ;;
    rzp_test_*) echo "  The value you pasted is a test key, but a different one — so the" ;
                echo "  dashboard is a different Razorpay account (or a second set of test" ;
                echo "  keys on the same account)." ;;
    *)          echo "  The value you pasted is not in rzp_test_/rzp_live_ form — check you" ;
                echo "  copied the Key Id and not the Key Secret or an id from another page." ;;
  esac
  rc=1
fi

unset TYPED STORED POS_GATEWAY_KEY_ID POS_GATEWAY_KEY_SECRET POS_GATEWAY_WEBHOOK_SECRET
exit $rc
