/**
 * Playwright config for end-to-end smoke tests.
 *
 * The suite runs against a Next dev server started by Playwright.
 * We intentionally override the Supabase env so the app always
 * points at the LOCAL Supabase stack during e2e — even if the
 * developer's `.env.local` is wired to a remote project. Process
 * env takes precedence over `.env.local` in Next.js.
 *
 * Global setup (`tests/e2e/global-setup.ts`) seeds an admin user
 * and writes `playwright/.auth/admin.json` (session cookies). Every
 * test re-uses that storageState and starts already signed-in.
 */
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const LOCAL_SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? '3100');
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // auth cookies + shared seed → run serially
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    storageState: resolve(process.cwd(), 'playwright/.auth/admin.json'),
  },

  globalSetup: './tests/e2e/global-setup.ts',

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: LOCAL_ANON_KEY,
      NODE_ENV: 'development',
    },
  },
});
