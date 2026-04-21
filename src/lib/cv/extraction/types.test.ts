/**
 * Unit tests for the `ExtractionResult` Zod schema (ADR-012 §2).
 *
 * The schema is the contract between:
 *   - OpenAI's json_schema response (enforced from outside)
 *   - Internal consumers (worker, downstream derivation in F4-005)
 *
 * Every backend (LLM, future linkedin parser, stub) must round-trip
 * through this validator. The tests below are adversarial: every field
 * has a rule from §2, and we prove that bad shapes are rejected.
 */
import { describe, expect, it } from 'vitest';

import { ExtractionResultSchema, type ExtractionResult } from './types';

function valid(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'Acme',
        title: 'Senior Engineer',
        start_date: '2020-01',
        end_date: null,
        description: 'Built things.',
        skills: ['TypeScript', 'React.js'],
      },
    ],
    languages: [{ name: 'English', level: 'C1' }],
  };
}

describe('ExtractionResultSchema — ADR-012 §2 contract', () => {
  it('accepts a minimal valid payload', () => {
    expect(() => ExtractionResultSchema.parse(valid())).not.toThrow();
  });

  it('accepts empty arrays (no experiences, no languages)', () => {
    const payload: ExtractionResult = {
      source_variant: 'linkedin_export',
      experiences: [],
      languages: [],
    };
    expect(() => ExtractionResultSchema.parse(payload)).not.toThrow();
  });

  it('rejects unknown source_variant values', () => {
    const bad = { ...valid(), source_variant: 'scanned_pdf' };
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it('rejects experience.kind outside {work, side_project, education}', () => {
    const bad = valid();
    bad.experiences[0]!.kind = 'hobby' as unknown as 'work';
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it('accepts null company, title, dates, description (per schema)', () => {
    const payload = valid();
    payload.experiences[0] = {
      kind: 'side_project',
      company: null,
      title: null,
      start_date: null,
      end_date: null,
      description: null,
      skills: [],
    };
    expect(() => ExtractionResultSchema.parse(payload)).not.toThrow();
  });

  it('accepts YYYY-MM and YYYY-MM-DD in dates', () => {
    const p1 = valid();
    p1.experiences[0]!.start_date = '2024-03';
    p1.experiences[0]!.end_date = '2024-12-31';
    expect(() => ExtractionResultSchema.parse(p1)).not.toThrow();
  });

  it('rejects dates that are not ISO-8601 partial', () => {
    const p = valid();
    p.experiences[0]!.start_date = 'March 2024' as unknown as string;
    expect(() => ExtractionResultSchema.parse(p)).toThrow();

    const q = valid();
    q.experiences[0]!.end_date = '03/2024' as unknown as string;
    expect(() => ExtractionResultSchema.parse(q)).toThrow();
  });

  it('rejects skills that are not strings', () => {
    const bad = valid();
    (bad.experiences[0] as { skills: unknown }).skills = ['React', 123];
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it('rejects experiences missing required fields', () => {
    // Missing kind
    const bad = valid();
    delete (bad.experiences[0] as Partial<(typeof bad.experiences)[number]>).kind;
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it('rejects language without name', () => {
    const bad = valid();
    (bad.languages[0] as { name: unknown }).name = null;
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it('accepts language with null level (unknown fluency)', () => {
    const payload = valid();
    payload.languages[0] = { name: 'Portuguese', level: null };
    expect(() => ExtractionResultSchema.parse(payload)).not.toThrow();
  });

  it('strips unknown top-level keys (deterministic parse)', () => {
    const extra = { ...valid(), unknown_key: 'smuggled' };
    const parsed = ExtractionResultSchema.parse(extra) as Record<string, unknown>;
    expect(parsed.unknown_key).toBeUndefined();
  });
});
