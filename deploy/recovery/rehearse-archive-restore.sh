#!/usr/bin/env bash
# Rehearse the FULL encrypted-recovery chain unattended:
#   real production dump + its manifest -> tar -> gpg encrypt -> .tar.gpg
#     -> gpg decrypt -> tar -> pg_restore -> row-level reconciliation
#
# Why this exists. The owner's 2026-09-25 run proved the real off-host archive
# opens with the real key and yields dump sha256 45cc0768…  What it did not do
# is put those bytes into Postgres, so "the encrypted archive is recoverable"
# was still unproven at the database end. The passphrase for the production
# backup key is the owner's and is deliberately never requested here, so this
# script proves every link with a THROWAWAY key instead, on the real
# production bytes.
#
# What that does and does not establish, stated plainly because the previous
# version of this evidence overreached on exactly this point:
#   PROVES   an encrypted archive containing dump 45cc0768… decrypts, restores
#            into Postgres, and reconciles to the manifest carried inside it.
#   DOES NOT prove the production key opens the production ciphertext — that is
#            what the owner's run proved, on the same dump hash.
#   REMAINS  a single end-to-end run on one artifact with the owner's own key:
#            owner-verify-backup-restore.sh.
# The composition is legitimate only because both halves name the SAME dump
# sha256. Joining halves that named DIFFERENT dumps is the error this whole
# section was corrected for on 2026-09-25; do not reintroduce it.
#
# Encryption is invoked exactly as deploy/pos-backup-offhost.mjs does it
# (--trust-model always, --auto-key-locate clear, tar of dump+manifest into
# gpg), so the artifact under test has the same shape as a shipped one.
#
# Isolation: a throwaway GNUPGHOME under mktemp -d, removed on exit. The
# production keyring at ~/.gnupg is never read, written, or unlocked, and no
# key, archive or revocation certificate is touched.
set -uo pipefail

SRC_DIR="${SRC_DIR:-/home/atc-noc/atc-backups/pos-prod}"
# The 09-24 archive is the one the owner actually decrypted, so its inner dump
# is the only artifact for which the owner-key half is already proven.
STAMP_NAME="${STAMP_NAME:-pos-prod-20260924T211406Z}"
HERE="$(cd "$(dirname "$0")" && pwd)"

DUMP="$SRC_DIR/$STAMP_NAME.dump"
MANIFEST="$SRC_DIR/$STAMP_NAME.manifest"

for f in "$DUMP" "$MANIFEST"; do
  [ -f "$f" ] || { echo "REHEARSAL FAIL — missing $f"; exit 1; }
done

WORK="$(mktemp -d)" || exit 1
export GNUPGHOME="$WORK/kr"
mkdir -p "$GNUPGHOME"
chmod 700 "$WORK" "$GNUPGHOME"
cleanup() {
  gpgconf --kill all >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "rehearsal keyring : $GNUPGHOME  (throwaway, removed on exit)"
echo "source dump       : $DUMP"
echo "source sha256     : $(sha256sum "$DUMP" | cut -d' ' -f1)"

# --- 1. throwaway recipient key ---------------------------------------------
# --passphrase '' with loopback: otherwise gpg tries to open a pinentry and
# hangs unattended. This key never leaves $WORK and is destroyed on exit.
if ! gpg --batch --yes --passphrase '' --pinentry-mode loopback \
        --quick-generate-key 'VEXO Connect Rehearsal <rehearsal@invalid>' \
        rsa4096 encr never >"$WORK/gen.log" 2>&1; then
  echo "REHEARSAL FAIL — could not generate the throwaway key"; tail -3 "$WORK/gen.log"; exit 1
fi
echo "throwaway key     : generated"

# --- 2. build the archive the way the shipper builds it ----------------------
ARCHIVE="$WORK/$STAMP_NAME.tar.gpg"
if ! tar -C "$SRC_DIR" -cf - "$STAMP_NAME.dump" "$STAMP_NAME.manifest" \
     | gpg --batch --yes --trust-model always --auto-key-locate clear \
           --encrypt --recipient 'rehearsal@invalid' --output "$ARCHIVE" \
           2>"$WORK/enc.log"; then
  echo "REHEARSAL FAIL — encryption failed"; tail -3 "$WORK/enc.log"; exit 1
fi
echo "archive built     : $(stat -c%s "$ARCHIVE") bytes"
echo

# --- 3. run the real restore verifier against that ciphertext ---------------
# Same script, same assertions, that the owner run will use — so handing it
# over is handing over something already exercised end to end.
python3 "$HERE/restore_from_archive.py" \
  --archive "$ARCHIVE" \
  --gnupghome "$GNUPGHOME" \
  --batch-empty-passphrase \
  --label rehearse
rc=$?

echo
if [ "$rc" -eq 0 ]; then
  echo "REHEARSAL RESULT: PASS — the encrypted-archive -> isolated-DB chain works end to end"
else
  echo "REHEARSAL RESULT: FAIL — see the failing rows above"
fi
exit "$rc"
