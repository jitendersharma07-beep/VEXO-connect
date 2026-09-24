import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    // fileParallelism above serializes files inside ONE run. This worktree's
    // tests run against vcx_foundation_test, which the x/foundation lane also
    // wipes, so runs have to be serialized ACROSS worktrees too — globalSetup
    // holds a Postgres advisory lock for the length of the run, on the same key
    // foundation uses. See tests/globalSetup.js.
    globalSetup: ['./tests/globalSetup.js'],
    // Vitest defaults NODE_ENV to "test" only when the shell left it UNSET.
    // A terminal exporting NODE_ENV=development defeats rateLimit.js's
    // load-time isTest skip and the 300 req/min limiter 429s the fast files
    // (gateway 429 incident, 2026-09-24 — control: tests/rateLimit.test.js).
    // Pin it so the suite's environment never depends on the shell.
    env: { NODE_ENV: 'test' },
  },
});
