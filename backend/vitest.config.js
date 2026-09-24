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
  },
});
