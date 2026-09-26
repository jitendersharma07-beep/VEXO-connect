"""Section 7 — restore an ENCRYPTED backup archive into a NEW isolated database.

This closes the row that `restore_drill.py` could not: that script starts from a
plaintext `.dump` already sitting on this host, so it proves the restore
mechanism but says nothing about the archives that are actually shipped
off-host. This one starts from a `.tar.gpg` and executes the whole chain —
ciphertext -> gpg --decrypt -> tar -> pg_restore -> row-level reconciliation.

Two rules make the result mean something:

  * The manifest is read FROM INSIDE the archive, never from
    ~/atc-backups/pos-prod. An archive has to be self-describing to be a
    backup; checking it against a local file we happen to still have would
    prove nothing about recoverability after losing this host, which is the
    entire scenario off-host archives exist for.
  * The decrypted dump is production data — 16 staff password hashes among
    other things. It lives only inside a mode-0700 mktemp that is removed in a
    finally block, and the copy pushed into the restore container is deleted
    again before exit. Nothing is printed but hashes, sizes and counts.

Isolation contract:
  reads  : the archive named on the command line (read-only, never rewritten)
  writes : two FRESH, uniquely-named databases in the vexo-connect-dev-db
           container, plus a 0700 temp directory. No DROP of anything: the
           script cannot destroy a database by being wrong about a name.
  never  : pos-prod-postgres-1, any retained archive, any key, any revocation
           certificate, and no database that already existed.

Usage
  # owner run, real archive, real key — gpg prompts once for the passphrase
  python3 restore_from_archive.py --archive /path/pos-prod-<stamp>.tar.gpg

  # unattended rehearsal against a throwaway key in an isolated keyring
  python3 restore_from_archive.py --archive /tmp/x.tar.gpg \
      --gnupghome /tmp/kr --batch-empty-passphrase
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

CTR = "vexo-connect-dev-db"
USER = "vexo_dev"

rows = []


def step(name, ok, detail=""):
    rows.append((name, "PASS" if ok else "FAIL", detail))
    return ok


def sh(args, **kw):
    p = subprocess.run(args, capture_output=True, text=True, **kw)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def psql(db, q):
    return sh(["docker", "exec", CTR, "psql", "-U", USER, "-d", db,
               "-tA", "-v", "ON_ERROR_STOP=1", "-c", q])


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gpg_argv(args, extra):
    argv = ["gpg", "--quiet"]
    if args.batch_empty_passphrase:
        argv += ["--batch", "--yes", "--passphrase", "", "--pinentry-mode", "loopback"]
    return argv + extra


def gpg_env(args):
    env = dict(os.environ)
    if args.gnupghome:
        env["GNUPGHOME"] = args.gnupghome
    return env


def decrypt_into(args, archive, dest):
    """Stream `gpg --decrypt <archive>` into `tar -x` under dest.

    Streaming rather than decrypt-to-file-then-untar is deliberate: it matches
    what owner-verify-backup-decrypt.sh already does, and it never leaves a
    whole decrypted tarball on disk in addition to its contents.
    """
    env = gpg_env(args)
    g = subprocess.Popen(gpg_argv(args, ["--decrypt", archive]),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    t = subprocess.Popen(["tar", "-C", dest, "-x"],
                         stdin=g.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    g.stdout.close()
    t_out, t_err = t.communicate()
    g.wait()
    g_err = g.stderr.read().decode(errors="replace")
    g.stderr.close()
    return g.returncode, t.returncode, g_err, t_err.decode(errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    ap.add_argument("--gnupghome", default="")
    ap.add_argument("--batch-empty-passphrase", action="store_true")
    ap.add_argument("--expect-archive-sha", default="",
                    help="shipping-receipt sha256; checked when supplied")
    ap.add_argument("--label", default="arch")
    a = ap.parse_args()

    stamp = time.strftime("%Y%m%dt%H%M%S")
    drill = f"vcx_{a.label}_{stamp}"
    negctl = f"vcx_{a.label}neg_{stamp}"
    archive = os.path.abspath(a.archive)

    print(f"archive      : {archive}")
    print(f"restore into : {CTR}:{drill}  (new, isolated)")

    if not os.path.isfile(archive):
        print(f"\nFATAL: no such archive: {archive}")
        return 2
    before_sha = sha256_file(archive)
    print(f"archive sha256: {before_sha}")

    work = tempfile.mkdtemp(prefix="vcx-arestore-")
    os.chmod(work, 0o700)
    inner_ctr = f"/tmp/vcx-arestore-{stamp}.dump"
    trunc_ctr = f"/tmp/vcx-arestore-{stamp}.trunc"
    try:
        # ---- 1. it must be ciphertext, and addressed to exactly one key -----
        # A shipper bug that skipped encryption would produce a plain tar with
        # the same filename. Checking the magic bytes is how that gets caught
        # rather than assumed.
        with open(archive, "rb") as fh:
            head = fh.read(512)
        looks_tar = head[257:262] == b"ustar"
        looks_gz = head[:2] == b"\x1f\x8b"
        step("archive is ciphertext, not a plain tar or gzip",
             not looks_tar and not looks_gz,
             "no ustar/gzip magic" if not (looks_tar or looks_gz) else "PLAINTEXT ARCHIVE")

        # --list-packets needs no secret key and no passphrase, so the
        # recipient can be asserted before anyone is asked to type anything.
        rc, out, err = sh(gpg_argv(a, ["--list-packets", archive]), env=gpg_env(a))
        blob = out + "\n" + err
        keyids = []
        for line in blob.split("\n"):
            if "keyid" in line:
                for tok in line.replace(",", " ").split():
                    if len(tok) == 16 and all(c in "0123456789ABCDEFabcdef" for c in tok):
                        keyids.append(tok.upper())
        keyids = sorted(set(keyids))
        step("archive is addressed to exactly one recipient key", len(keyids) == 1,
             ", ".join(keyids) if keyids else "could not read any recipient keyid")

        if a.expect_archive_sha:
            step("archive sha256 matches the shipping receipt",
                 before_sha == a.expect_archive_sha.lower(),
                 "matches" if before_sha == a.expect_archive_sha.lower()
                 else f"{before_sha[:16]}… vs receipt {a.expect_archive_sha[:16]}…")

        # ---- 2. decrypt + extract -------------------------------------------
        grc, trc, gerr, terr = decrypt_into(a, archive, work)
        ok_dec = grc == 0 and trc == 0
        if not step("archive decrypts and extracts", ok_dec,
                    "gpg exit 0, tar exit 0" if ok_dec
                    else f"gpg {grc} / tar {trc}: {(gerr or terr).splitlines()[-1][:80] if (gerr or terr) else ''}"):
            return

        got = sorted(os.listdir(work))
        dumps = [f for f in got if f.endswith(".dump")]
        mans = [f for f in got if f.endswith(".manifest")]
        step("decrypted archive contains a dump and a manifest",
             len(dumps) == 1 and len(mans) == 1, ", ".join(got))
        if not (dumps and mans):
            return
        dump = os.path.join(work, dumps[0])
        # The manifest comes out of the ARCHIVE, not off local disk. That is
        # what makes this a recoverability test and not a comparison against a
        # copy we would not have after losing this host.
        mf = json.load(open(os.path.join(work, mans[0])))

        # ---- 3. integrity: the dump is the one the manifest describes -------
        size = os.path.getsize(dump)
        digest = sha256_file(dump)
        step("decrypted dump size matches the manifest inside the archive",
             size == mf["dumpBytes"], f'{size} vs {mf["dumpBytes"]}')
        step("decrypted dump sha256 matches the manifest inside the archive",
             digest == mf["dumpSha256"], digest[:24] + "…")
        rc, out, _ = sh(["file", "-b", dump])
        step("decrypted dump is a PostgreSQL custom dump",
             "custom database dump" in out, out[:60])
        print(f"taken at     : {mf.get('takenAt')}")
        print(f"source db    : {mf.get('container')}\n")

        # ---- 4. restore into a brand-new database ---------------------------
        sh(["docker", "cp", dump, f"{CTR}:{inner_ctr}"])
        rc, _, err = psql("postgres", f"CREATE DATABASE {drill}")
        if not step("new isolated database created", rc == 0,
                    drill if rc == 0 else err[:90]):
            return

        # --exit-on-error matters: pg_restore's default is to log an error,
        # carry on, and exit 0, which is how a half-restored database gets
        # called a successful restore. The negative control below proves the
        # flag is doing its job.
        rc, _, err = sh(["docker", "exec", CTR, "pg_restore", "-U", USER,
                         "-d", drill, "--no-owner", "--exit-on-error", inner_ctr])
        step("pg_restore completed with no errors", rc == 0,
             "exit 0" if rc == 0 else err.split("\n")[0][:90])

        # ---- 5. row-level reconciliation, every model in the manifest -------
        mism, checked = [], 0
        for t, want in mf["rows"].items():
            after = mf.get("rowsAfter", {}).get(t, want)
            lo, hi = min(want, after), max(want, after)
            rc, out, _ = psql(drill, f'select count(*) from "{t}"')
            n = int(out) if rc == 0 and out.isdigit() else None
            checked += 1
            if n is None:
                mism.append(f"{t}: missing from the restore (backup recorded {lo})")
            elif not (lo <= n <= hi):
                mism.append(f"{t}: backup recorded {lo}, restore has {n}")
        step(f"all {checked} models restored to their recorded counts", not mism,
             "; ".join(mism)[:120] if mism else f"{checked}/{checked} models agree")

        # ---- 6. the money, the migrations, and who can log in ---------------
        rc, out, _ = psql(drill, 'select coalesce(sum(amount),0)::text from "Payment"')
        step("payment total matches the backup",
             rc == 0 and float(out) == float(mf["paymentAmountSum"]),
             f'restore {out} vs manifest {mf["paymentAmountSum"]}')

        rc, out, _ = psql(drill, 'select count(*) from "_prisma_migrations"')
        step("migration state matches the backup",
             rc == 0 and int(out) == mf["migrationsApplied"],
             f'{out} applied vs manifest {mf["migrationsApplied"]}')

        rc, out, _ = psql(drill, 'select count(*) from "_prisma_migrations"'
                                 ' where "finished_at" is null')
        step("no migration left half-applied", rc == 0 and int(out) == 0,
             f"{out} unfinished")

        rc, out, _ = psql(drill, 'select count(*) from "PosUser"'
                                 ' where "passwordHash" is not null'
                                 ' and length("passwordHash") > 20')
        step("staff logins survived with usable password hashes",
             rc == 0 and int(out) == mf["staffLoginsWithHash"],
             f'{out} vs manifest {mf["staffLoginsWithHash"]}')

        rc, out, _ = psql(drill, "select count(*) from pg_constraint where contype='f'")
        step("foreign keys restored", rc == 0 and int(out) > 0, f"{out} FK constraints")
        rc, out, _ = psql(drill, "select count(*) from pg_indexes where schemaname='public'")
        step("indexes restored", rc == 0 and int(out) > 0, f"{out} indexes")
        rc, out, _ = psql(drill, 'select count(*) from "Payment" p'
                                 ' left join "Order" o on o.id = p."orderId"'
                                 ' where o.id is null')
        step("no payment orphaned from its order", rc == 0 and int(out) == 0,
             f"{out} orphans")

        # ---- 7. negative control A: tampered ciphertext must not open -------
        # The integrity claim rests on GPG's MDC actually rejecting a modified
        # archive. Flip one byte in a COPY and prove the failure is real.
        tampered = os.path.join(work, "tampered.tar.gpg")
        shutil.copy2(archive, tampered)
        with open(tampered, "r+b") as fh:
            fh.seek(os.path.getsize(tampered) // 2)
            b = fh.read(1)
            fh.seek(os.path.getsize(tampered) // 2)
            fh.write(bytes([b[0] ^ 0xFF]))
        tdir = os.path.join(work, "tdir")
        os.makedirs(tdir, exist_ok=True)
        grc2, trc2, gerr2, _ = decrypt_into(a, tampered, tdir)
        step("a tampered archive FAILS to decrypt (integrity is enforced)",
             not (grc2 == 0 and trc2 == 0),
             f"gpg {grc2} / tar {trc2}" if not (grc2 == 0 and trc2 == 0)
             else "TAMPERED ARCHIVE OPENED CLEANLY")

        # ---- 8. negative control B: a truncated dump must stop the restore --
        sh(["docker", "exec", CTR, "sh", "-c",
            f"head -c 40000 {inner_ctr} > {trunc_ctr}"])
        psql("postgres", f"CREATE DATABASE {negctl}")
        rc, _, err = sh(["docker", "exec", CTR, "pg_restore", "-U", USER,
                         "-d", negctl, "--no-owner", "--exit-on-error", trunc_ctr])
        step("a truncated dump FAILS the restore (does not exit 0)", rc != 0,
             f"exit {rc}: {err.splitlines()[0][:70] if err else ''}")
        rc2, out, _ = psql(negctl, "select count(*) from information_schema.tables"
                                   " where table_schema='public'")
        step("the failed restore did NOT leave a complete-looking database",
             rc2 == 0 and int(out) < len(mf["rows"]),
             f'{out} tables vs {len(mf["rows"])} in a good restore')

        # ---- 9. nothing was consumed or leaked ------------------------------
        step("the archive is byte-identical after the drill",
             sha256_file(archive) == before_sha, "unchanged")

        print(f"\nleft in place for inspection: {CTR}:{drill} (good restore), "
              f"{CTR}:{negctl} (failed restore)")
    finally:
        # The decrypted production dump must not outlive the run, in the temp
        # directory or inside the container.
        sh(["docker", "exec", CTR, "rm", "-f", inner_ctr, trunc_ctr])
        shutil.rmtree(work, ignore_errors=True)
        gone = not os.path.exists(work)
        rc, out, _ = sh(["docker", "exec", CTR, "sh", "-c",
                         f"ls {inner_ctr} 2>/dev/null | wc -l"])
        step("no decrypted production dump left on disk or in the container",
             gone and out.strip() == "0",
             f"tempdir removed={gone}, container copies={out.strip()}")


def report(rs):
    print("\n===== results =====")
    for n, v, d in rs:
        print(f"{v:<5} {n:<58} {d}")
    bad = [r for r in rs if r[1] == "FAIL"]
    print(f"\n{len(rs) - len(bad)}/{len(rs)} PASS")
    return 1 if bad else 0


if __name__ == "__main__":
    # main() records steps and never reports, so the cleanup assertion added in
    # its finally block is inside the count. Reporting from main would have
    # printed "21/21" for 22 assertions.
    fatal = main()
    if fatal:
        sys.exit(fatal)
    sys.exit(report(rows))
