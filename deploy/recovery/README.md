# Recovery toolkit

These are the scripts that turn "we have archives" into "we have proven we can
restore them". They sit beside `deploy/pos-backup.mjs`, which is what writes the
archives in the first place, and they are the tooling referenced by
`docs/CLOUD-READINESS-VERIFICATION.md` and `docs/BACKUP-RESTORE.md`.

## Why they are in Git now

Until this commit they existed only at `/home/atc-noc/vcx-cloudready-local/` on
the production host, untracked. That is the one place they are useless: they are
the tools for recovering from the loss of that machine, and they would have been
lost with it.

To be precise about what was and was not at risk — the *runbook*
(`docs/BACKUP-RESTORE.md`) has always been committed, and the restore chain is
standard tooling (`gpg` → `tar` → `pg_restore`), so a competent operator could
always have restored by hand. What did not survive was the ability to **verify**
a restore: the 22-assertion reconciliation against the manifest carried inside
the archive, which is the evidence that a restore is complete and not merely
successful-looking. That is what these files preserve.

The decryption key is a separate problem and is **not** solved by this commit.
See `WINDOW-1-GATE-TABLE.md` §B.

## What each one does

| File | Starts from | Touches a database? | Use |
|---|---|---|---|
| `restore_from_archive.py` | a `.tar.gpg` | yes — two fresh, uniquely-named DBs | The full chain: ciphertext → decrypt → extract → `pg_restore` → row-level reconciliation against the manifest **read from inside the archive**. This is the one that returned 22/22 on the real 09-24 production bytes. |
| `restore_drill.py` | a plaintext `.dump` already on disk | yes — a fresh DB | Proves the restore mechanism. Says nothing about the archives actually shipped off-host, which is why `restore_from_archive.py` exists. |
| `owner-verify-backup-decrypt.sh` | a `.tar.gpg` | **no** | Owner-run integrity check: fetch, sha256 against the shipping receipt, decrypt, confirm dump + manifest are inside, compare hashes. No database at all. |
| `owner-verify-backup-restore.sh` | a `.tar.gpg` | yes — a throwaway DB it drops afterwards | Owner-run variant that does restore. Supersedes the "declines to restore" limit of the decrypt-only script. |
| `rehearse-archive-restore.sh` | a re-sealed archive | yes | Unattended rehearsal against a throwaway key in an isolated keyring — no real key, no passphrase prompt. |
| `control-mismatched-manifest.sh` | a deliberately mismatched archive | yes | Negative control. Seals the 09-24 dump with the 09-23 manifest and asserts the reconciliation **fails**. Without this, a passing run proves nothing — an assertion that cannot fail is not a test. |

## Safety contract

These were written to be run against production archives, so the constraints are
deliberate and worth keeping if you edit them:

- **No secrets are embedded.** Postgres is reached via `docker exec` (container
  trust), and GPG always prompts for the passphrase — except in the rehearsal
  path, which uses an isolated keyring with an empty-passphrase throwaway key.
  Nothing here reads a credential from a file or a variable you have to set.
- **Nothing is dropped that already existed.** Databases are created fresh with
  unique names. The scripts cannot destroy a database by being wrong about a
  name.
- **Decrypted production data is production data.** It lives only inside a
  mode-0700 `mktemp` removed in a `finally`/`trap`, the copy pushed into the
  container is deleted before exit, and nothing is printed but hashes, sizes and
  counts.
- **No archive, key or revocation certificate is ever deleted.**

## Running them

`restore_from_archive.py` carries its own usage in the module docstring. The
short form:

```text
# owner run, real archive, real key — gpg prompts once for the passphrase
python3 restore_from_archive.py --archive /path/pos-prod-<stamp>.tar.gpg

# unattended rehearsal against a throwaway key in an isolated keyring
python3 restore_from_archive.py --archive /tmp/x.tar.gpg \
    --gnupghome /tmp/kr --batch-empty-passphrase
```

The container and user they target (`vexo-connect-dev-db`, `vexo_dev`) are
constants near the top of the file. On a rebuilt host they will need changing to
whatever isolated Postgres you have — that is the only edit a recovery operator
should need to make.
