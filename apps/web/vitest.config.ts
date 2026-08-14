import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Now that this package has two integration test files sharing
    // one real Postgres, serialize them — see the identical fix (and
    // its rationale) in apps/simulation-worker/vitest.config.ts.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
