import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    // globalSetup does two things, both about residue from OTHER runs.
    // fileParallelism above serializes files inside ONE run; the advisory lock
    // serializes runs ACROSS worktrees, which share a test database. Then it
    // empties that database, because a run that CRASHED leaves rows the next
    // run's per-file wipes have no statement for. See tests/globalSetup.js.
    globalSetup: ['./tests/globalSetup.js'],
    // Vitest defaults NODE_ENV to "test" only when the shell left it UNSET.
    // A terminal exporting NODE_ENV=development defeats rateLimit.js's
    // load-time isTest skip and the 300 req/min limiter 429s the fast files
    // (gateway 429 incident, 2026-09-24 — control: tests/rateLimit.test.js).
    // Pin it so the suite's environment never depends on the shell.
    env: { NODE_ENV: 'test' },
  },
});
