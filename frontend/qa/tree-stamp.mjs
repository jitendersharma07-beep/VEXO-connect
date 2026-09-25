// Which tree did this evidence actually come from?
//
// D-4 exists because a results-*.json produced in a lane reached main as a
// merge resolution and read, to anyone who opened it, like main's own result.
// It was caught only by an absence: main's harness writes `at` on the same
// line as `passed`, the lane's did not, so a file with one and not the other
// could not have come from main. That worked, but it is a tell, not a check —
// it depended on the two harnesses having drifted in exactly that way.
//
// This makes the check positive. A harness stamps the tree it is running FROM
// (its own directory's git checkout, not the caller's cwd and not an env var a
// caller can forget), so a lane-produced file names the lane in its own text.
// Nobody has to notice a missing field.
//
// Self-derived on purpose: `QA_TREE=…` passed in by a runner would be stamped
// correctly by the runner that was already correct, and wrongly or not at all
// by the one that was not — which is the failure this is meant to catch.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const treeStamp = (moduleUrl) => {
  const here = dirname(fileURLToPath(moduleUrl));
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', here, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null; // a tarball export is not a git checkout; say so, don't crash
    }
  };
  // `git rev-parse --show-toplevel` follows a worktree's .git FILE to the real
  // checkout root, which is what every lane here is.
  //
  // `contentSha` is the answer to the objection that `baseSha` + `dirty: true`
  // does not identify what was tested. It is a real git tree object over the
  // WORKING TREE — every tracked and every untracked-but-not-ignored file, at
  // the bytes on disk — written through a throwaway index so the caller's own
  // staging area is not touched. Two runs agreeing on `contentSha` tested byte
  // for byte the same content whatever their HEADs say, and a run whose fixes
  // were uncommitted at the time can still be matched to the commit that later
  // contained them. `baseSha` says where the work started; this says what ran.
  const contentSha = () => {
    const index = join(tmpdir(), `qa-stamp-index-${process.pid}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: index };
      execFileSync('git', ['-C', here, 'add', '-A'], { env, stdio: 'ignore' });
      return execFileSync('git', ['-C', here, 'write-tree'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    } finally {
      try {
        execFileSync('rm', ['-f', index], { stdio: 'ignore' });
      } catch {
        /* the temp index is disposable; failing to remove it is not a result */
      }
    }
  };

  return {
    tree: git('rev-parse', '--show-toplevel'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    baseSha: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain') === null ? null : git('status', '--porcelain') !== '',
    contentSha: contentSha(),
  };
};

// Which BACKEND did this evidence actually exercise, against which database,
// at which schema?
//
// `treeStamp` above answers "which checkout wrote this file". That is not the
// same question, and D-4's whole lesson is that the difference matters: the
// runner used to resolve $BACKEND to a different lane entirely, and a green
// artifact said nothing about it. A harness that stamped only its own directory
// would have been just as green.
//
// Everything below is derived from the SOCKET THE HARNESS IS TESTING, never
// from an argument the runner passes in. The runner is the one party that
// cannot be trusted to describe itself here — a value it supplies is stamped
// correctly by the runner that was already correct, and wrongly by the one that
// was not. Going port -> listening pid -> /proc means a misconfigured runner
// produces an artifact that says so.
//
// Nothing secret is returned. The backend's environment is read to find which
// database it opened, and only the database NAME leaves this function: no
// password, no URL, no JWT secret, not even the host.
export const runtimeStamp = (apiBaseUrl, treeRoot) => {
  const out = {
    backendCwd: null,
    backendInTree: null,
    database: null,
    schemaDigest: null,
    migrationsOnDisk: null,
  };
  try {
    const port = new URL(apiBaseUrl).port;
    // `ss -ltnp` reports the pid only for sockets this user owns, which is
    // exactly the set we are entitled to ask about.
    const listeners = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
    const line = listeners.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l));
    const pid = line && line.match(/pid=(\d+)/)?.[1];
    if (!pid) return out;

    out.backendCwd = execFileSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' }).trim();
    out.backendInTree = Boolean(treeRoot) && out.backendCwd.startsWith(treeRoot);

    // Migration COUNT comes off the backend's own directory rather than the
    // harness's, so a backend running from somewhere else is counted there.
    try {
      out.migrationsOnDisk = readdirSync(join(out.backendCwd, 'prisma', 'migrations')).filter(
        (d) => /^\d/.test(d),
      ).length;
    } catch {
      out.migrationsOnDisk = null; // not a backend checkout — itself a finding
    }

    // The database it actually opened. /proc/<pid>/environ holds the password
    // and the JWT secret too, so this parses out the path component and lets
    // everything else fall out of scope with the string.
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const url = env.find((e) => e.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
    if (url) out.database = new URL(url).pathname.replace(/^\//, '') || null;

    // The schema AS THE DATABASE HOLDS IT, not as the migrations claim. The QA
    // databases are built by replaying migration SQL, so `_prisma_migrations`
    // is empty in them and a migration count would prove nothing about the
    // shape the backend actually queried. A digest over every column of every
    // public table changes the moment a migration is missing, extra, or partly
    // applied.
    if (out.database) {
      const sql = `SELECT md5(string_agg(x, E'\\n' ORDER BY x)) FROM (
        SELECT table_name||'.'||column_name||':'||data_type AS x
        FROM information_schema.columns WHERE table_schema='public') s`;
      out.schemaDigest =
        execFileSync(
          'docker',
          ['exec', 'atc-pos-dev-db', 'psql', '-U', 'atc_pos', '-d', out.database, '-Atc', sql],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .trim()
          .slice(0, 12) || null;
    }
  } catch {
    // A stamp that cannot be taken must not fail the run it is describing. The
    // nulls left above are the report.
  }
  return out;
};
