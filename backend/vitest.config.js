import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    // Vitest defaults NODE_ENV to "test" only when the shell left it UNSET.
    // A runner that sources a dev .env exports NODE_ENV=development, which
    // defeats rateLimit.js's load-time isTest skip and lets the 300 req/min
    // global limiter answer 429 to fixtures midway through a run — that is the
    // foundation "gateway 429" incident of 2026-09-24. The vcxmi runner passes
    // NODE_ENV=test on the vitest command line; pinning it here covers a bare
    // `npx vitest run` too.
    env: { NODE_ENV: 'test' },
  },
});
