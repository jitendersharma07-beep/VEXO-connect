"""Section 7 — restore a real encrypted-backup dump into a NEW isolated database
and reconcile it against that archive's own manifest.

Isolation contract:
  * reads  : /home/atc-noc/atc-backups/pos-prod/*.dump|.manifest   (read-only)
  * writes : two FRESH, uniquely-named databases inside the vexo-connect-dev-db
             container that this verification already owns. They are created
             and left in place for inspection — this script deletes nothing,
             so it cannot destroy anything by being wrong about a name.
  * never  : pos-prod-postgres-1, vexo-lab (20.20.20.57), any retained archive,
             any key or revocation certificate.
"""
import hashlib, json, os, subprocess, sys, time

ARCHIVE_DIR = "/home/atc-noc/atc-backups/pos-prod"
CTR = "vexo-connect-dev-db"
USER = "vexo_dev"
STAMP = time.strftime("%Y%m%dt%H%M%S")
DRILL = f"vcx_restore_{STAMP}"
NEGCTL = f"vcx_negctl_{STAMP}"

rows = []


def step(name, ok, detail=""):
    rows.append((name, "PASS" if ok else "FAIL", detail))
    return ok


def sh(args):
    p = subprocess.run(args, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def psql(db, q):
    return sh(["docker", "exec", CTR, "psql", "-U", USER, "-d", db,
               "-tA", "-v", "ON_ERROR_STOP=1", "-c", q])


# ---- 1. pick the archive ----------------------------------------------------
# An archive with no manifest records nothing to check the restore against,
# so "cannot tell" would read as a pass. Only manifested archives qualify.
cand = [f for f in os.listdir(ARCHIVE_DIR) if f.endswith(".dump")
        and os.path.exists(os.path.join(ARCHIVE_DIR, f[:-5] + ".manifest"))]
cand.sort(key=lambda f: os.path.getmtime(os.path.join(ARCHIVE_DIR, f)))
skipped = len([f for f in os.listdir(ARCHIVE_DIR) if f.endswith(".dump")]) - len(cand)
newest = cand[-1]
src = os.path.join(ARCHIVE_DIR, newest)
mpath = src[:-5] + ".manifest"
mf = json.load(open(mpath))
if skipped:
    print(f"note: {skipped} dump(s) skipped — no manifest, so fidelity is unverifiable")

print(f"archive      : {newest}")
print(f"taken at     : {mf['takenAt']}")
print(f"source db    : {mf['container']}")
print(f"restore into : {CTR}:{DRILL}  (new, isolated)\n")

# ---- 2. identity: bytes + checksum vs the manifest --------------------------
size = os.path.getsize(src)
digest = hashlib.sha256(open(src, "rb").read()).hexdigest()
step("archive size matches its manifest", size == mf["dumpBytes"],
     f"{size} vs {mf['dumpBytes']}")
step("archive sha256 matches its manifest", digest == mf["dumpSha256"],
     digest[:16] + "…")
rc, out, _ = sh(["file", "-b", src])
step("archive is a PostgreSQL custom dump", "custom database dump" in out, out)

# ---- 3. restore into a brand-new database -----------------------------------
inner = "/tmp/vcx-drill.dump"
sh(["docker", "cp", src, f"{CTR}:{inner}"])
rc, _, err = psql("postgres", f"CREATE DATABASE {DRILL}")
step("new isolated database created", rc == 0, DRILL if rc == 0 else err[:90])

rc, _, err = sh(["docker", "exec", CTR, "pg_restore", "-U", USER,
                 "-d", DRILL, "--no-owner", "--exit-on-error", inner])
step("pg_restore completed with no errors", rc == 0,
     "exit 0" if rc == 0 else err.split("\n")[0][:90])

# ---- 4. reconcile every table against the manifest --------------------------
mism, checked = [], 0
for t, want in mf["rows"].items():
    after = mf.get("rowsAfter", {}).get(t, want)
    lo, hi = min(want, after), max(want, after)
    rc, out, _ = psql(DRILL, f'select count(*) from "{t}"')
    got = int(out) if rc == 0 and out.isdigit() else None
    checked += 1
    if got is None:
        mism.append(f"{t}: missing from the restore (backup recorded {lo})")
    elif not (lo <= got <= hi):
        mism.append(f"{t}: backup recorded {lo}, restore has {got}")
step(f"all {checked} tables restored to their recorded counts", not mism,
     "; ".join(mism)[:120] if mism else f"{checked}/{checked} tables agree")

# ---- 5. the money, the migrations, and who can log in -----------------------
rc, out, _ = psql(DRILL, 'select coalesce(sum(amount),0)::text from "Payment"')
step("payment total matches the backup", rc == 0 and float(out) == float(mf["paymentAmountSum"]),
     f'restore {out} vs manifest {mf["paymentAmountSum"]}')

rc, out, _ = psql(DRILL, 'select count(*) from "_prisma_migrations"')
step("migration state matches the backup", rc == 0 and int(out) == mf["migrationsApplied"],
     f'{out} applied vs manifest {mf["migrationsApplied"]}')

rc, out, _ = psql(DRILL, 'select count(*) from "_prisma_migrations" where "finished_at" is null')
step("no migration left half-applied", rc == 0 and int(out) == 0, f"{out} unfinished")

rc, out, _ = psql(DRILL, 'select count(*) from "PosUser" where "passwordHash" is not null'
                         ' and length("passwordHash") > 20')
step("staff logins survived with usable password hashes",
     rc == 0 and int(out) == mf["staffLoginsWithHash"],
     f'{out} vs manifest {mf["staffLoginsWithHash"]}')

# integrity: the restore must carry constraints, not just rows
rc, out, _ = psql(DRILL, "select count(*) from pg_constraint where contype='f'")
step("foreign keys restored", rc == 0 and int(out) > 0, f"{out} FK constraints")
rc, out, _ = psql(DRILL, "select count(*) from pg_indexes where schemaname='public'")
step("indexes restored", rc == 0 and int(out) > 0, f"{out} indexes")

# a restored order must still reconcile internally
rc, out, _ = psql(DRILL, 'select count(*) from "Payment" p'
                         ' left join "Order" o on o.id = p."orderId"'
                         ' where o.id is null')
step("no payment orphaned from its order", rc == 0 and int(out) == 0,
     f"{out} orphans")

# ---- 6. NEGATIVE CONTROL: a damaged archive must stop, not half-restore -----
trunc = f"/tmp/vcx-trunc-{STAMP}.dump"
rc, out, _ = sh(["docker", "exec", CTR, "sh", "-c",
                 f"head -c 40000 {inner} > {trunc}; echo done"])
psql("postgres", f"CREATE DATABASE {NEGCTL}")
rc, _, err = sh(["docker", "exec", CTR, "pg_restore", "-U", USER,
                 "-d", NEGCTL, "--no-owner", "--exit-on-error", trunc])
step("a truncated archive FAILS the restore (does not exit 0)", rc != 0,
     f"exit {rc}: {err.split(chr(10))[0][:80]}")
rc2, out, _ = psql(NEGCTL, "select count(*) from information_schema.tables"
                           " where table_schema='public'")
full_tables = len(mf["rows"])
step("the failed restore did NOT leave a complete-looking database",
     rc2 == 0 and int(out) < full_tables, f"{out} tables vs {full_tables} in a good restore")

# ---- 7. the archive must be untouched by all of the above -------------------
print(f"\nleft in place for inspection: {CTR}:{DRILL} (good restore), "
      f"{CTR}:{NEGCTL} (failed restore)\n")

after = hashlib.sha256(open(src, "rb").read()).hexdigest()
step("the retained archive is byte-identical after the drill", after == digest,
     "unchanged")

print("===== results =====")
for n, v, d in rows:
    print(f"{v:<5} {n:<58} {d}")
bad = [r for r in rows if r[1] == "FAIL"]
print(f"\n{len(rows)-len(bad)}/{len(rows)} PASS")
sys.exit(1 if bad else 0)
