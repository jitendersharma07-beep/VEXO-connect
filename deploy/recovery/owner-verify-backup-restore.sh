#!/usr/bin/env bash
# Close the last open row of section 7 in ONE command:
#
#     bash ~/vcx-cloudready-local/owner-verify-backup-restore.sh
#
# It takes the real off-host encrypted archive, decrypts it with the real
# backup key, restores the dump that comes out of it into a NEW isolated
# database, and reconciles that database row-by-row against the manifest
# carried inside the archive. GPG prompts once for the backup key passphrase.
# Nothing else is asked for.
#
# THE ONLY THING TO SEND BACK IS THE SINGLE `RESULT:` LINE.
# Do not paste the passphrase, the scrollback, or anything from the restored
# database — the dump is production data and includes 16 staff password hashes.
#
# ---------------------------------------------------------------------------
# Why this supersedes owner-verify-backup-decrypt.sh
#
# That script stopped at "the archive opens and the bytes match the manifest",
# and said so honestly: it never touched a database. So after it passed on
# 2026-09-25 the recoverability question was still open, because no dump had
# ever been taken OUT of an encrypted archive and put INTO Postgres. The old
# script is kept and still works; this one is a superset and is the one that
# closes the row.
#
# It also fixes a latent defect in that script: the expected archive hash was a
# baked-in constant, so every nightly ship made it one day more stale. On
# 2026-09-26 the receipt already named the 09-25 archive while the constant
# still named 09-24. This script reads the live shipping receipt instead, so it
# cannot rot — and it refuses to run on a receipt that is not `status: ok`
# rather than comparing against a hash with no witness.
#
# What it will NOT do:
#   * delete or overwrite any archive, on either host (the fetch is an scp pull)
#   * move, export, alter or delete any key or the revocation certificate
#   * write to pos-prod-postgres-1, or to any database that already exists
#   * leave the decrypted production dump anywhere after it exits
# ---------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RECEIPT="$HOME/atc-backups/offhost-state/last-offhost.json"
REMOTE="atc@20.20.20.57:/home/atc/atc-backups/pos-prod-offhost"
LOG="$HERE/.owner-verify.log"

say()    { printf '%s\n' "$*"; }
result() { printf 'RESULT: %s\n' "$*"; printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

for t in gpg tar sha256sum mktemp python3 docker scp; do
  command -v "$t" >/dev/null 2>&1 || { result "FAIL — $t is not installed"; exit 1; }
done

# --- 1. which archive, and what should it hash to -- read from the receipt ---
# Reading the receipt rather than hardcoding is the fix for the staleness trap
# described above. A malformed or failed receipt aborts rather than guesses.
[ -f "$RECEIPT" ] || { result "FAIL — no shipping receipt at $RECEIPT"; exit 1; }
read -r STATUS ARCHIVE_NAME EXPECT_SHA < <(python3 -c '
import json, sys
r = json.load(open(sys.argv[1]))
print(r.get("status",""), r.get("archive",""), r.get("sha256",""))
' "$RECEIPT") || { result "FAIL — could not parse $RECEIPT"; exit 1; }

if [ "$STATUS" != "ok" ]; then
  result "FAIL — the last off-host ship reported status=$STATUS; fix shipping before testing recovery"
  exit 1
fi
[ -n "$ARCHIVE_NAME" ] && [ -n "$EXPECT_SHA" ] || {
  result "FAIL — receipt names no archive or no sha256"; exit 1; }

say "archive per receipt : $ARCHIVE_NAME"
say "expected sha256     : $EXPECT_SHA"

# --- 2. get a copy: prefer local, else pull read-only from the destination ---
WORK="$(mktemp -d)" || { result "FAIL — could not create a temp directory"; exit 1; }
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

SRC=""
for d in "$HOME/atc-backups/outbound" "$HOME/atc-backups/pos-prod" "$HOME"; do
  [ -f "$d/$ARCHIVE_NAME" ] && { SRC="$d/$ARCHIVE_NAME"; break; }
done

if [ -z "$SRC" ]; then
  say "no local copy; fetching from $REMOTE (read-only pull)"
  if ! scp -q "$REMOTE/$ARCHIVE_NAME" "$WORK/$ARCHIVE_NAME"; then
    result "FAIL — could not fetch $ARCHIVE_NAME from the off-host destination"
    exit 1
  fi
  SRC="$WORK/$ARCHIVE_NAME"
fi
say "archive             : $SRC"
say ""
say "GPG will now ask for the backup key passphrase (once)."
say ""

# --- 3. the whole chain, with every assertion ------------------------------
# Same verifier, same assertions, that were exercised end to end on 2026-09-26
# by rehearse-archive-restore.sh (22/22 PASS) and shown to be load-bearing by
# control-mismatched-manifest.sh (rejected an inconsistent archive). The only
# line here that has never been executed is gpg's use of the production key —
# which is the whole point of handing this over.
python3 "$HERE/restore_from_archive.py" \
  --archive "$SRC" \
  --expect-archive-sha "$EXPECT_SHA" \
  --label ownerrestore
rc=$?

say ""
if [ "$rc" -eq 0 ]; then
  result "PASS — $ARCHIVE_NAME decrypts, restores into an isolated database, and reconciles to the manifest inside it"
  exit 0
fi
result "FAIL — the encrypted-archive restore did not fully pass (exit $rc); the per-assertion table above says which row"
exit 1
