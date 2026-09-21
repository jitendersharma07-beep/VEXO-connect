#!/bin/bash
# Store Razorpay SANDBOX credentials for the dev box, once, so the gateway can
# be started and restarted without typing them again.
#
# WHAT THIS SCRIPT WILL NOT DO
#
# It never prints a secret. Not on success, not in an error, not in a prompt
# echo, not in a diagnostic. Everything it says is PASS, FAIL or an instruction,
# because a setup transcript gets pasted into chats and tickets, and a
# credential that reaches a transcript is a credential that has to be rotated.
# If you want to read the file back, that is `cat` in your own terminal and your
# decision to make, not something this script does for you.
#
# The three values are read from the terminal with echo off. They are therefore
# never in argv (which is world-readable in /proc), never in the shell history
# file, and never in a log. They go straight to a file this script creates at
# mode 0600 inside a directory it creates at mode 0700.
#
# WHY A FILE AT ALL
#
# Typing three secrets at every restart is a fine rule for one demo and a bad
# one for a day of sandbox testing: the pressure to paste them into a command
# line — where argv and history both keep them — grows with every restart. A
# 0600 file that git cannot see is the safer end of that trade.
#
# WHY IT DOES NOT TRUST .gitignore
#
# A .gitignore line is a claim that a file is safe. `git check-ignore` is the
# check of that claim, and it is the one that catches a rule edited, moved or
# overridden by a global config. This script runs it on the exact path and
# refuses to write anything if git does not confirm. A credential file that git
# can see is a worse outcome than no credential file.
#
# THIS IS A DEV-BOX SCRIPT. It refuses live keys and writes nothing that any
# deployment reads: no .env is touched, and production is not involved.

set -uo pipefail
umask 077

REPO=/home/atc-noc/atc-pos
DIR="$REPO/backend/.secrets"
FILE="$DIR/razorpay-sandbox.env"

[ -t 0 ] || { echo "FAIL: no terminal: these values must be typed, never piped or pasted from a file"; exit 2; }

# Echo is turned off for the WHOLE prompting section, not per-read, and this is
# not a stylistic choice. `read -s` disables echo only once it is already
# running, so anything sitting in the terminal buffer when it starts has already
# been echoed by the tty — and a three-line paste, which is exactly how someone
# transfers three credentials, puts lines two and three in that buffer. Turning
# echo off first closes that window. Observed, not theorised: an early version
# of this script printed a pasted key id to the screen.
TTY_STATE="$(stty -g < /dev/tty)"
restore_tty() { stty "$TTY_STATE" < /dev/tty 2>/dev/null; }
# EXIT covers every way out, including the success path and a `set -e` style
# abort. Leaving a terminal with echo off is a real harm of its own: the
# operator types their next command and sees nothing come back.
trap restore_tty EXIT
trap 'restore_tty; printf "\nFAIL: interrupted, nothing was written\n"; exit 2' INT TERM
fail() { restore_tty; echo "FAIL: $1"; exit 2; }

ask() {
  local prompt="$1" __var="$2" __val="" __discard=""
  stty -echo < /dev/tty
  # Anything typed or pasted ahead of this prompt is dropped rather than used.
  # A pasted block would otherwise answer the next prompt with a value the
  # operator never saw and cannot check — a webhook secret silently set to a
  # key secret is a webhook that rejects every event for no visible reason.
  while IFS= read -r -t 0.05 __discard < /dev/tty; do :; done
  printf '%s' "$prompt" > /dev/tty
  IFS= read -r __val < /dev/tty
  printf '\n' > /dev/tty
  printf -v "$__var" '%s' "$__val"
}
cd "$REPO" || fail "repo not found at $REPO"

# --- prove the target is invisible to git BEFORE creating it -----------------
mkdir -p "$DIR" || fail "could not create $DIR"
chmod 700 "$DIR"
if ! git check-ignore -q "$FILE"; then
  echo "FAIL: git does NOT ignore $FILE"
  echo "       Nothing has been written. Add '.secrets/' to .gitignore first —"
  echo "       a credential file git can see is worse than none."
  exit 2
fi

if [ -e "$FILE" ]; then
  printf 'Credentials already exist. Replace them? [y/N] ' > /dev/tty
  read -r REPLY < /dev/tty
  case "$REPLY" in [yY]*) : ;; *) echo "PASS: kept the existing credentials, nothing changed"; exit 0 ;; esac
fi

# --- the three values --------------------------------------------------------
echo
echo "From the Razorpay dashboard, in TEST mode:"
echo "  Account & Settings -> API Keys -> Generate Test Key"
echo
ask 'Razorpay TEST key id (rzp_test_...): ' KEY_ID
ask 'Razorpay TEST key secret: '           KEY_SECRET
echo
echo "The webhook secret is a string YOU choose. You will type the same one"
echo "into the Razorpay webhook form in a moment. It is not shown back to you."
echo
ask 'Webhook secret (16+ characters): '    WH_SECRET

# Test and live keys differ only by this substring, and the same hostname serves
# both — so this prefix is the ONLY thing standing between a sandbox script and
# a real customer's money. It is checked before anything is written.
case "$KEY_ID" in
  *_live_*)   fail "that is a LIVE key. This is a sandbox-only script; nothing was written" ;;
  rzp_test_*) : ;;
  *)          fail "key id does not start with rzp_test_ ; nothing was written" ;;
esac
[ "${#KEY_ID}" -ge 12 ]     || fail "key id is too short to be real; nothing was written"
[ -n "$KEY_SECRET" ]        || fail "key secret is empty; nothing was written"
[ "${#WH_SECRET}" -ge 16 ]  || fail "webhook secret must be at least 16 characters; nothing was written"

# Values are stored single-quoted, which carries $ ` " \ and spaces intact but
# cannot carry a single quote. The webhook secret is whatever the operator
# invents, so one can genuinely appear — and the failure would be silent and
# baffling: the file would hold a DIFFERENT secret from the one typed into the
# Razorpay form, and every event would fail its signature check with nothing to
# point at. Refuse it at the prompt instead.
case "$KEY_ID$KEY_SECRET$WH_SECRET" in
  *\'*) fail "a single quote ' is not supported in these values; choose a webhook secret without one. Nothing was written" ;;
esac

# --- write, at 0600, with the secrets never passing through argv -------------
# A heredoc keeps the values inside this process. Quoting every value means a
# secret containing a space or a $ is still read back intact by the launcher.
( set -o noclobber; : > "$FILE" ) 2>/dev/null || { : > "$FILE"; }
chmod 600 "$FILE"
cat > "$FILE" <<EOF
# Razorpay SANDBOX credentials for the dev box. Mode 0600, git-ignored.
# Written by backend/scripts/razorpay-sandbox-setup.sh — do not commit, do not
# paste into a chat, and do not copy to any deployed machine.
POS_GATEWAY_PROVIDER='razorpay'
POS_GATEWAY_KEY_ID='$KEY_ID'
POS_GATEWAY_KEY_SECRET='$KEY_SECRET'
POS_GATEWAY_WEBHOOK_SECRET='$WH_SECRET'
EOF
unset KEY_ID KEY_SECRET WH_SECRET

# Verify the protection that was promised, rather than assuming the chmod and
# the ignore rule both held.
PERM="$(stat -c '%a' "$FILE")"
[ "$PERM" = "600" ] || fail "file mode is $PERM, expected 600"
git check-ignore -q "$FILE" || fail "file was written but git can see it — delete $FILE now"
git status --porcelain --ignored=no -- "$FILE" | grep -q . && fail "git is tracking $FILE — delete it now"

echo
echo "PASS: credentials stored, mode 0600"
echo "PASS: git cannot see the file (check-ignore confirms, not just .gitignore)"
echo "PASS: key id is a TEST key"
echo "PASS: nothing was printed that needs rotating"
echo
echo "Next, in the Razorpay dashboard -> Settings -> Webhooks -> Add New Webhook:"
echo
echo "  URL     https://<your-tunnel-host>/api/gateway/webhook"
echo "  Secret  the SAME string you just typed"
echo "  Events  tick EXACTLY these four, and nothing else:"
echo "            payment.captured"
echo "            payment.failed"
echo "            refund.processed"
echo "            refund.failed"
echo
echo "Those four are the whole set this build maps (EVENT_MAP in"
echo "backend/src/lib/gateway/razorpay.js). Anything else ticked is accepted,"
echo "recorded and deliberately not applied — payment.authorized above all,"
echo "which means money is blocked on the card and NOT received."
echo
echo "Then start the gateway with:  bash backend/scripts/dev-gateway-up.sh"
