import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    // fileParallelism above serializes files inside ONE run. Several agents
    // share this lane's single test database, so runs have to be serialized
    // against each other too — globalSetup holds a Postgres advisory lock for
    // the length of the run. See tests/globalSetup.js for the 2026-09-24
    // evidence of two runs wiping each other's fixtures.
    globalSetup: ['./tests/globalSetup.js'],
  },
});
