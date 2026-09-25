import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // globalSetup does two things, in this order: takes a Postgres advisory
    // lock for the length of the run, then empties the database.
    //
    // fileParallelism above serializes files inside ONE run; the lock serializes
    // whole runs ACROSS worktrees, which matters because some lanes point at a
    // database another lane also wipes. The emptying then clears residue a
    // CRASHED earlier run left behind, which the per-file wipes have no
    // statement for and which surfaces as failures belonging to that run.
    // See tests/globalSetup.js.
    globalSetup: ['./tests/globalSetup.js'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Vitest defaults NODE_ENV to "test" only when the shell left it UNSET.
    // A terminal exporting NODE_ENV=development defeats rateLimit.js's
    // load-time isTest skip and the 300 req/min limiter 429s the fast files
    // (gateway 429 incident, 2026-09-24 — control: tests/rateLimit.test.js).
    // Pin it so the suite's environment never depends on the shell.
    env: { NODE_ENV: 'test' },
  },
});
