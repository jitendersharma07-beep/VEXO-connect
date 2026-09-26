#!/usr/bin/env bash
# Prove that an off-host encrypted POS backup can actually be opened.
#
# This is the one step of the cloud-readiness verification that could not be
# completed unattended: it needs the passphrase for the backup key, which is
# the owner's and was deliberately never requested.
#
# Run it on atc-noc, as atc-noc:
#
#     bash ~/vcx-cloudready-local/owner-verify-backup-decrypt.sh
#
# GPG will prompt once for the passphrase. Nothing else is asked for, the
# passphrase is never written anywhere, and the only thing worth sending back
# is the single RESULT: line it prints at the end.
#
# What it does NOT do, on purpose:
#   * never deletes an archive, a key, or the revocation certificate
#   * never writes outside a fresh mktemp -d, which it removes on exit
#   * never touches a database — the restore half is already proven
#   * never writes the decrypted dump anywhere but that temp directory
#
# It appends one line per run to ~/vcx-cloudready-local/.owner-verify.log so
# there is a record of when it was run and what it said.
#
# EXPECT IT TO PULL OVER THE NETWORK. Checked 2026-09-25: there is no
# .tar.gpg anywhere under ~/atc-backups on this host — `outbound/` is empty,
# because shipping removes the archive once it is away. Only the plaintext
# .dump and .manifest stay behind. So the "prefer a local copy" branch below
# never fires today, and the run begins with an scp from
# 20.20.20.57 (vexo-lab), which is the off-host backup destination.
#
# That matters for two reasons:
#   * the host must be reachable and the owner's SSH key accepted, or the run
#     fails at the fetch with nothing said about the archive or the key;
#   * this verification session was scoped OUT of vexo-lab, so the fetch was
#     never exercised from here. It is the one step of this script that has
#     not been rehearsed.
# The scp is a read. It pulls; it does not push, overwrite or delete.

set -uo pipefail

# Re-pointed 2026-09-25. This was the 2026-09-23 archive with sha 50f7137...,
# which was a real shipment — offhost.log still records it going out at
# 21:15:01Z — but its receipt has since been overwritten by the nightly run,
# so that hash no longer has a witness on this host. Step 2 compares against
# the receipt, so an unverifiable hash would abort the run BEFORE the
# decryption it exists to test: a FAIL that says nothing about the key.
#
# These three values are corroborated, checked 2026-09-25:
#   offhost-state/last-offhost.json  archive + sha256 + 43822 bytes, status ok
#   pos-prod-20260924T211406Z.manifest  dumpSha256 45cc0768...
#   sha256sum of the local .dump        45cc0768...  — matches the manifest
ARCHIVE_NAME="pos-prod-20260924T211406Z.tar.gpg"
EXPECT_ARCHIVE_SHA="4720f54da8c0aa0936c3eda47af71ce078a36e2589bfc4110ff7d2073c3f9e9f"
REMOTE="atc@20.20.20.57:/home/atc/atc-backups/pos-prod-offhost"
LOG="$HOME/vcx-cloudready-local/.owner-verify.log"

say()    { printf '%s\n' "$*"; }
result() { printf 'RESULT: %s\n' "$*"; printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

# --- 0. tools ---------------------------------------------------------------
for t in gpg tar sha256sum mktemp; do
  command -v "$t" >/dev/null 2>&1 || { result "FAIL — $t is not installed"; exit 1; }
done

# --- 1. find the archive ----------------------------------------------------
# Prefer a copy already on this host; otherwise fetch one from the off-host
# destination. The fetch is a READ: scp pulls, it does not push or delete.
SRC=""
for d in "$HOME/atc-backups/outbound" "$HOME/atc-backups/pos-prod" "$HOME"; do
  [ -f "$d/$ARCHIVE_NAME" ] && { SRC="$d/$ARCHIVE_NAME"; break; }
done

WORK="$(mktemp -d)" || { result "FAIL — could not create a temp directory"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

if [ -z "$SRC" ]; then
  say "no local copy; fetching from $REMOTE (read-only)"
  if ! scp -q "$REMOTE/$ARCHIVE_NAME" "$WORK/$ARCHIVE_NAME"; then
    result "FAIL — could not fetch $ARCHIVE_NAME from the off-host destination"
    exit 1
  fi
  SRC="$WORK/$ARCHIVE_NAME"
fi
say "archive: $SRC"

# --- 2. identity ------------------------------------------------------------
GOT_SHA="$(sha256sum "$SRC" | cut -d' ' -f1)"
if [ "$GOT_SHA" != "$EXPECT_ARCHIVE_SHA" ]; then
  result "FAIL — archive sha256 is $GOT_SHA, the shipping receipt recorded $EXPECT_ARCHIVE_SHA"
  exit 1
fi
say "archive sha256 matches the shipping receipt"

# --- 3. the actual question: does it open? ----------------------------------
say ""
say "GPG will now ask for the backup key passphrase."
if ! gpg --decrypt "$SRC" 2>"$WORK/gpg.err" | tar -C "$WORK" -x; then
  say "--- gpg said: ---"
  tail -3 "$WORK/gpg.err"
  result "FAIL — the archive did not decrypt and extract"
  exit 1
fi

DUMP="$WORK/${ARCHIVE_NAME%.tar.gpg}.dump"
MANIFEST="$WORK/${ARCHIVE_NAME%.tar.gpg}.manifest"
[ -f "$DUMP" ]     || { result "FAIL — decrypted archive contains no dump";     exit 1; }
[ -f "$MANIFEST" ] || { result "FAIL — decrypted archive contains no manifest"; exit 1; }
say "decrypted: dump + manifest both present"

# --- 4. is the dump inside the one the manifest describes? ------------------
WANT="$(sed -n 's/.*"dumpSha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$MANIFEST" | head -1)"
GOT="$(sha256sum "$DUMP" | cut -d' ' -f1)"
[ -n "$WANT" ] || { result "FAIL — manifest records no dumpSha256 to check against"; exit 1; }

if [ "$WANT" = "$GOT" ]; then
  result "PASS — archive decrypts and the dump inside matches its manifest ($GOT)"
  exit 0
fi
result "FAIL — decrypted dump is $GOT, manifest recorded $WANT"
exit 1
