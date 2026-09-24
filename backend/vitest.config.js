import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // Empties the test database before the run. Without it, a crashed run
    // leaves residue that the next run's per-file wipes cannot clear, and the
    // suite reports failures that belong to the previous run.
    globalSetup: ['./tests/globalSetup.js'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
