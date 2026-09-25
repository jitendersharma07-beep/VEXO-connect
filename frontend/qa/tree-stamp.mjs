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
import { dirname } from 'node:path';
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
  return {
    tree: git('rev-parse', '--show-toplevel'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    baseSha: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain') === null ? null : git('status', '--porcelain') !== '',
  };
};
