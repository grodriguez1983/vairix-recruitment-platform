/**
 * Unit tests for `classifyVariant` — determinístico, sin I/O.
 *
 * Contrato (ADR-012 §1, docs/roadmap.md F4-003):
 *   - input: parsed_text (string) — cualquier whitespace
 *   - output: { variant: 'linkedin_export' | 'cv_primary', confidence: number }
 *   - default seguro: cv_primary para texto vacío o señal ambigua
 *     (ADR-012 §7 — mejor pasar un LinkedIn por LLM que parsear mal
 *     un CV real con el parser determinístico).
 *
 * Diseño del score (ADR-012 §1, heurísticas conservadoras):
 *   +3  secuencia ordenada "Contact" → "Experience" → "Education"
 *       (tres headers exactos, en ese orden, como anchor de línea)
 *   +2  header "Top Skills" presente (exclusivo de LinkedIn export)
 *   +1  URL linkedin.com/in/<slug>
 *   +1  ≥ 2 patrones de fecha "<Mes> <Year> - Present" o "MM/YYYY - Present"
 *
 * Threshold: score ≥ 3 → linkedin_export, else cv_primary.
 *
 * Rationale adversarial (de roadmap):
 *   - URL de LinkedIn en CV normal NO alcanza por sí sola (+1 < 3).
 *   - LinkedIn export sin URL pero con headers ordenados clasifica
 *     correctamente (+3 con Contact/Experience/Education).
 *   - Texto vacío o trivial → cv_primary.
 */
import { describe, expect, it } from 'vitest';

import { classifyVariant } from './variant-classifier';

describe('classifyVariant — ADR-012 §1 heurísticas deterministas', () => {
  // ──────────────────────────────────────────────────────────────
  // Default seguro: cv_primary
  // ──────────────────────────────────────────────────────────────

  it('classifies empty string as cv_primary', () => {
    const result = classifyVariant('');
    expect(result.variant).toBe('cv_primary');
    expect(result.confidence).toBe(0);
  });

  it('classifies whitespace-only text as cv_primary', () => {
    expect(classifyVariant('   \n\t  ').variant).toBe('cv_primary');
  });

  it('classifies a plain CV (no LinkedIn markers) as cv_primary', () => {
    const text = `
Jane Doe
Senior Software Engineer

Professional Experience
Acme Corp — Tech Lead (2020 – 2024)
  Built the thing. Led the team.

Skills
JavaScript, TypeScript, React, Node.js

Education
Universidad de Buenos Aires — Ingeniería en Sistemas (2015 – 2020)
`;
    expect(classifyVariant(text).variant).toBe('cv_primary');
  });

  // ──────────────────────────────────────────────────────────────
  // Adversarial: URL alone is insufficient
  // ──────────────────────────────────────────────────────────────

  it('classifies a CV with a LinkedIn URL but otherwise normal layout as cv_primary', () => {
    // URL solo aporta +1 < threshold de 3.
    const text = `
Jane Doe — Senior Engineer
Contacto: jane@example.com · +54 911 5555 · linkedin.com/in/janedoe
GitHub: github.com/janedoe

Perfil
Ingeniera con foco en backend distribuido.

Experiencia profesional
2021 – 2024 · Acme Corp — Staff Engineer
2018 – 2021 · Beta SA — Senior Engineer

Educación
2015 – 2020 · UBA — Ing. en Sistemas
`;
    expect(classifyVariant(text).variant).toBe('cv_primary');
  });

  // ──────────────────────────────────────────────────────────────
  // Positive path: LinkedIn export
  // ──────────────────────────────────────────────────────────────

  it('classifies a full LinkedIn export (URL + Top Skills + ordered headers) as linkedin_export', () => {
    const text = `
Jane Doe
Senior Engineer at Acme

Contact
jane@example.com
www.linkedin.com/in/janedoe

Top Skills
TypeScript
React
Node.js

Experience
Acme Corp
Staff Engineer
January 2021 - Present (4 years 3 months)
Built the distributed pipeline.

Beta SA
Senior Engineer
June 2018 - December 2020 (2 years 6 months)

Education
Universidad de Buenos Aires
Ingeniería en Sistemas, Software Engineering
2015 - 2020
`;
    const result = classifyVariant(text);
    expect(result.variant).toBe('linkedin_export');
    expect(result.confidence).toBeGreaterThanOrEqual(3);
  });

  it('classifies a LinkedIn export WITHOUT URL but with ordered headers as linkedin_export', () => {
    // Contact + Experience + Education en orden = +3 (threshold).
    const text = `
Jane Doe
Staff Engineer

Contact
jane@example.com · +54 911 5555

Experience
Acme Corp
Staff Engineer
January 2021 - Present

Education
UBA — Ing. en Sistemas
2015 - 2020
`;
    expect(classifyVariant(text).variant).toBe('linkedin_export');
  });

  it('classifies a LinkedIn export that has Top Skills + URL but NOT all ordered headers', () => {
    // Top Skills +2 + URL +1 = 3 → cruza threshold.
    const text = `
Jane Doe

Top Skills
TypeScript
React

linkedin.com/in/janedoe

Some other text without the canonical headers in order.
Career summary blah blah.
`;
    expect(classifyVariant(text).variant).toBe('linkedin_export');
  });

  // ──────────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────────

  it('treats "Contact" as a header only when it anchors a line (not inside prose)', () => {
    // "Contact" inside prose no debe contar como header — evita
    // falsos positivos en CVs que digan "Please contact me at ...".
    const text = `
John Smith — Full Stack Developer
Please contact me at john@example.com for the Experience section link.
Education at UBA, 2015 - 2020.
`;
    expect(classifyVariant(text).variant).toBe('cv_primary');
  });

  it('is case-sensitive on headers (lowercase "contact" not a LinkedIn signal)', () => {
    // LinkedIn exports usan "Contact" con capital inicial como
    // header autónomo; "contact" en minúscula casi siempre es prosa.
    const text = `
Jane Doe
contact information below
experience history follows
education details
linkedin.com/in/janedoe
`;
    expect(classifyVariant(text).variant).toBe('cv_primary');
  });

  it('requires the ordered header sequence to actually be in order', () => {
    // Education antes de Experience rompe el ordered-sequence bonus.
    const text = `
Education
UBA — Ing. en Sistemas

Experience
Beta SA — Engineer (2015 - 2020)

Contact
jane@example.com
`;
    // Sin "Top Skills" ni URL ni ordered sequence (está al revés):
    // score = 0 → cv_primary.
    expect(classifyVariant(text).variant).toBe('cv_primary');
  });

  it('recognizes "Month Year - Present" date patterns toward confidence', () => {
    const text = `
Some Person

Top Skills
React

January 2020 - Present
June 2018 - December 2019
March 2015 - Present
`;
    // Top Skills (+2) + 2+ "- Present" patterns (+1) = 3 → linkedin_export.
    expect(classifyVariant(text).variant).toBe('linkedin_export');
  });

  it('confidence score is bounded and non-negative', () => {
    expect(classifyVariant('').confidence).toBeGreaterThanOrEqual(0);
    expect(classifyVariant('Contact\nExperience\nEducation').confidence).toBeLessThanOrEqual(10);
  });

  it('is deterministic — same input, same output', () => {
    const text = `
Contact
Experience
Education
linkedin.com/in/foo
Top Skills
`;
    const a = classifyVariant(text);
    const b = classifyVariant(text);
    expect(a).toEqual(b);
  });
});
