import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // RLS tests hit a shared local Supabase; run serialized to avoid
    // cross-test bleed. Unit tests in src/ can parallelize.
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: false },
    },
  },
});
