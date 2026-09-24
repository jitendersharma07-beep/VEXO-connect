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
    // Vitest defaults NODE_ENV to "test" only when the shell left it UNSET.
    // vcx-kitchen-local/.env exports NODE_ENV=development, which defeats
    // rateLimit.js's load-time isTest skip and lets the 300 req/min limiter
    // 429 fast files (foundation's gateway 429 incident, 2026-09-24 —
    // control: tests/rateLimit.test.js). The vcxk runner overrides it on the
    // vitest command line; pinning it here covers bare `npx vitest run` too.
    env: { NODE_ENV: 'test' },
  },
});
