/**
 * @smoke suite — critical happy path end-to-end.
 *
 * Keeps coverage shallow but broad: auth gate, search, filter,
 * profile, and logout. Deep assertions live in unit and RLS suites.
 * When this suite is red, the app is broken for a real user.
 *
 * The storage state is authenticated-as-admin (see global-setup).
 * Tests that need an unauthenticated context opt out explicitly.
 */
import { expect, test } from '@playwright/test';

test.describe('@smoke authenticated shell', () => {
  test('lands on home after auth with email visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Talent intelligence/i })).toBeVisible();
    await expect(page.getByText('e2e-admin@e2e.test', { exact: true })).toBeVisible();
  });

  test('candidates page shows empty state before any query', async ({ page }) => {
    await page.goto('/candidates');
    await expect(page.getByRole('heading', { name: 'Candidates' })).toBeVisible();
    await expect(page.getByText(/Start by typing a query/i)).toBeVisible();
  });

  test('query returns a seeded candidate', async ({ page }) => {
    await page.goto('/candidates');
    await page.getByRole('searchbox').fill('alice');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForURL(/\/candidates\?.*q=alice/);
    await expect(page.getByRole('heading', { name: 'Alice Lang' })).toBeVisible();
  });

  test('status filter narrows to active applications', async ({ page }) => {
    await page.goto('/candidates');
    await page.getByRole('button', { name: /^Filters/ }).click();
    // The `<label>` wraps both text and the `<select>`, so Playwright
    // derives the accessible name as `Status` + option text; scope by
    // the label element directly to keep the selector unambiguous.
    await page
      .locator('label', { hasText: /^Status/ })
      .locator('select')
      .selectOption('active');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForURL(/\/candidates\?.*status=active/);
    // Only Alice has an application, so only she should appear.
    await expect(page.getByRole('heading', { name: 'Alice Lang' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bob Smith' })).not.toBeVisible();
  });

  test('clicking a candidate opens their profile', async ({ page }) => {
    await page.goto('/candidates?q=alice');
    await page.getByRole('link', { name: /Alice Lang/ }).click();
    await page.waitForURL(/\/candidates\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: 'Alice Lang', level: 1 })).toBeVisible();
    await expect(page.getByText('Backend Engineer', { exact: true })).toBeVisible();
  });

  test('malformed candidate id renders 404 page', async ({ page }) => {
    await page.goto('/candidates/not-a-uuid');
    await expect(page.getByRole('heading', { name: 'Candidate not found' })).toBeVisible();
  });

  test('sign out returns to /login', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login$/);
    await expect(page.getByText('Sign in with your work email.')).toBeVisible();
  });
});

test.describe('@smoke unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects protected routes to /login', async ({ page }) => {
    await page.goto('/candidates');
    await page.waitForURL(/\/login/);
    await expect(page.getByText('Sign in with your work email.')).toBeVisible();
  });
});
