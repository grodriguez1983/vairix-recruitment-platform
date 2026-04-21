/**
 * Fixture-driven smoke test for `classifyVariant` (ADR-012 §1).
 *
 * Itera `tests/fixtures/cv-variants/<variant>/*.txt` y verifica que
 * cada muestra sintética clasifique en la carpeta que la contiene.
 * Los fixtures son intencionalmente anonimizados y chicos; su propósito
 * es cubrir "shapes" realistas que los unit tests inline no capturan:
 *
 *   - linkedin_export: headers ordenados + Top Skills + fechas "- Present",
 *     variaciones con/sin URL y con/sin Top Skills.
 *   - cv_primary: CVs en prosa, con URL de LinkedIn sola, estilo ATS,
 *     mención "contact" en prosa sin header autónomo.
 *
 * Un falso positivo acá rompe el test — señal de que una heurística
 * nueva degradó algún caso previamente cubierto.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyVariant, type CvVariant } from './variant-classifier';

const FIXTURES_ROOT = join(process.cwd(), 'tests/fixtures/cv-variants');

function listFixtures(variant: CvVariant): string[] {
  const dir = join(FIXTURES_ROOT, variant);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => join(dir, f));
}

describe('classifyVariant — fixture-driven', () => {
  const linkedinFixtures = listFixtures('linkedin_export');
  const cvFixtures = listFixtures('cv_primary');

  it('has ≥ 5 fixtures per variant (regression guard)', () => {
    expect(linkedinFixtures.length).toBeGreaterThanOrEqual(5);
    expect(cvFixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const path of linkedinFixtures) {
    it(`classifies ${path.split('/').slice(-2).join('/')} as linkedin_export`, () => {
      const text = readFileSync(path, 'utf8');
      const result = classifyVariant(text);
      expect(result.variant).toBe('linkedin_export');
      expect(result.confidence).toBeGreaterThanOrEqual(3);
    });
  }

  for (const path of cvFixtures) {
    it(`classifies ${path.split('/').slice(-2).join('/')} as cv_primary`, () => {
      const text = readFileSync(path, 'utf8');
      const result = classifyVariant(text);
      expect(result.variant).toBe('cv_primary');
      expect(result.confidence).toBeLessThan(3);
    });
  }
});
