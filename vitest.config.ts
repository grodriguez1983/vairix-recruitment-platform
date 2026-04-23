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
    // RLS + integration tests hit a dedicated test Supabase instance
    // (ADR-019). `.env.test` points SUPABASE_TEST_* + SUPABASE_* at
    // the test instance on ports 64321/64322, isolated from the dev
    // instance on 54321/54322. setupFiles runs per test-file worker
    // before module imports, so helpers.ts reads the overridden env
    // vars when it initializes its module-level constants.
    setupFiles: ['./tests/setup/load-test-env.ts'],
    // RLS tests hit a shared local Supabase; running in parallel causes
    // cross-test state bleed (one test's teardown races with another's
    // setup on the same table). Disable file-level parallelism.
    // If unit tests ever become slow enough that serialization matters,
    // split them into a separate vitest workspace/project.
    fileParallelism: false,
  },
});
