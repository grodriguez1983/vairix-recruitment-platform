/**
 * @smoke UC-11 matching surfaces.
 *
 * Deliberately shallow: deep assertions (scoring correctness, rescue
 * thresholds, decomposition cache, reconcile idempotency) live in
 * unit / integration suites. This spec only verifies that the pages
 * shipped in F4-009 render for an authenticated admin:
 *   - /matching/new (decompose entrypoint)
 *   - /matching/runs/:id (results + breakdown drawer + evidence load)
 *   - /admin/skills (catalog CRUD list)
 *   - /admin/skills/uncataloged (promotion/blacklist workflow)
 *
 * Fixtures are seeded by `global-setup.ts` via the service role:
 *   - skill   `e2e-react` with canonical_name "React"
 *   - Alice + CV file + one extraction + one experience
 *   - experience_skills rows: react (resolved) + zig (uncataloged)
 *   - one completed match_run with Alice ranked #1 (score 100)
 *
 * `/matching/new → decompose → run` is NOT exercised here because it
 * requires a live LLM call. That's deferred to a `@deep` suite that
 * stubs the decomposition provider.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

interface SeededIds {
  matchRunId: string;
  reactSkillId: string;
  candidateIds: string[];
  jobId: string;
}

function loadIds(): SeededIds {
  const path = resolve(process.cwd(), 'playwright/.auth/e2e-ids.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as SeededIds;
}

test.describe('@smoke matching UC-11', () => {
  test('new match page renders the JD form', async ({ page }) => {
    await page.goto('/matching/new');
    await expect(page.getByRole('heading', { name: /new match/i })).toBeVisible();
    // textarea for the JD paste.
    await expect(page.getByRole('textbox')).toBeVisible();
  });

  test('run detail shows Alice at rank #1 with passed gate', async ({ page }) => {
    const { matchRunId } = loadIds();
    await page.goto(`/matching/runs/${matchRunId}`);
    await expect(page.getByText(/match run/i)).toBeVisible();
    await expect(page.getByText('Alice Lang')).toBeVisible();
    await expect(page.getByText('passed', { exact: false })).toBeVisible();
    await expect(page.getByText('100.0')).toBeVisible();
  });

  test('expanding the Alice row renders the breakdown + evidence drawer', async ({ page }) => {
    const { matchRunId } = loadIds();
    await page.goto(`/matching/runs/${matchRunId}`);
    await page.getByRole('button', { name: /Alice Lang/ }).click();
    // The breakdown table has a column header `skill`; wait for it.
    await expect(page.getByRole('columnheader', { name: 'skill' })).toBeVisible();
    // React requirement row (seeded breakdown_json).
    await expect(page.getByRole('cell', { name: 'React' })).toBeVisible();
    // Evidence panel renders one of its three states (loading / ok / no-matches / error).
    await expect(page.getByText(/evidence/i)).toBeVisible();
  });

  test('/admin/skills lists the seeded React skill', async ({ page }) => {
    await page.goto('/admin/skills');
    await expect(page.getByRole('heading', { name: /Skills catalog/i })).toBeVisible();
    await page.getByRole('searchbox').fill('e2e-react');
    await page.getByRole('button', { name: /apply/i }).click();
    await page.waitForURL(/\/admin\/skills\?.*q=e2e-react/);
    await expect(page.getByRole('link', { name: /e2e-react/ })).toBeVisible();
  });

  test('/admin/skills/uncataloged surfaces the seeded zig alias', async ({ page }) => {
    await page.goto('/admin/skills/uncataloged');
    await expect(page.getByRole('heading', { name: /Uncataloged skills/i })).toBeVisible();
    await expect(page.getByText('zig', { exact: true })).toBeVisible();
  });

  test('admin landing links to the new surfaces', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Uncataloged skills' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Skills catalog' })).toBeVisible();
  });
});
