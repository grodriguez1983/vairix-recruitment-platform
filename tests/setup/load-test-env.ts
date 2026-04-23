/**
 * Vitest setupFile that loads `.env.test` into `process.env` before
 * any test file imports run (ADR-019).
 *
 * We don't use `dotenv` — the file format here is intentionally
 * trivial (KEY=VALUE, # comments, blank lines) so a short parser
 * avoids pulling a dependency. Values already in `process.env` (from
 * the shell or CI) are NOT overwritten; this matches the standard
 * dotenv precedence rule so CI can still inject secrets.
 *
 * This module has side effects at import time. Vitest runs it once
 * per worker before any test file's imports, which is exactly when
 * `tests/rls/helpers.ts` reads its module-level `SUPABASE_TEST_*`
 * constants.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_TEST_PATH = path.join(repoRoot, '.env.test');

function loadTestEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(ENV_TEST_PATH, 'utf8');
  } catch {
    // .env.test is optional — if it is missing, tests fall back to
    // the hardcoded defaults inside helpers.ts (which still point at
    // the dev instance). Exit quietly.
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === '') continue;
    // Shell / CI values win over .env.test.
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

loadTestEnv();
