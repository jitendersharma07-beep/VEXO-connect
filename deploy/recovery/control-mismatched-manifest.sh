#!/usr/bin/env bash
# Negative control for the VERIFIER, not for the backup.
#
# rehearse-archive-restore.sh returned 22/22 PASS. That is only meaningful if
# the assertions can fail. A reconciliation loop that compares a manifest to
# itself, or a hash check against a value read from the same file it is
# checking, passes on anything — and this repo has been burned by exactly that
# class of false pass before.
#
# So: build an archive that is internally INCONSISTENT — the 09-24 dump paired
# with the 09-23 manifest — and require the verifier to reject it. Expected
# failures are the size check, the sha256 check, and the row-level
# reconciliation (09-23 recorded different counts for the models that moved).
# If this run comes back PASS, the verifier is broken and its green run means
# nothing.
set -uo pipefail

SRC_DIR=/home/atc-noc/atc-backups/pos-prod
DUMP_STAMP=pos-prod-20260924T211406Z      # dump from the 24th
MAN_STAMP=pos-prod-20260923T211456Z       # manifest from the 23rd — deliberately wrong
HERE="$(cd "$(dirname "$0")" && pwd)"

WORK="$(mktemp -d)" || exit 1
export GNUPGHOME="$WORK/kr"
mkdir -p "$GNUPGHOME"; chmod 700 "$WORK" "$GNUPGHOME"
trap 'gpgconf --kill all >/dev/null 2>&1; rm -rf "$WORK"' EXIT

gpg --batch --yes --passphrase '' --pinentry-mode loopback \
    --quick-generate-key 'VEXO Control <control@invalid>' rsa4096 encr never \
    >"$WORK/gen.log" 2>&1 || { echo "CONTROL ERROR — keygen failed"; exit 1; }

# Stage the mismatched pair under a single stamp so the archive looks ordinary.
cp "$SRC_DIR/$DUMP_STAMP.dump"    "$WORK/$DUMP_STAMP.dump"
cp "$SRC_DIR/$MAN_STAMP.manifest" "$WORK/$DUMP_STAMP.manifest"

tar -C "$WORK" -cf - "$DUMP_STAMP.dump" "$DUMP_STAMP.manifest" \
  | gpg --batch --yes --trust-model always --auto-key-locate clear \
        --encrypt --recipient 'control@invalid' \
        --output "$WORK/$DUMP_STAMP.tar.gpg" 2>"$WORK/enc.log" \
  || { echo "CONTROL ERROR — encryption failed"; exit 1; }

echo "control archive: 09-24 dump + 09-23 manifest (deliberately mismatched)"
echo

python3 "$HERE/restore_from_archive.py" \
  --archive "$WORK/$DUMP_STAMP.tar.gpg" \
  --gnupghome "$GNUPGHOME" --batch-empty-passphrase --label ctlmis
rc=$?

echo
if [ "$rc" -ne 0 ]; then
  echo "CONTROL RESULT: PASS — the verifier REJECTED an inconsistent archive (exit $rc)."
  echo "The 22/22 run is therefore a real result and not a tautology."
  exit 0
fi
echo "CONTROL RESULT: FAIL — the verifier accepted a mismatched dump/manifest pair."
echo "Treat the 22/22 rehearsal as MEANINGLESS until this is fixed."
exit 1
