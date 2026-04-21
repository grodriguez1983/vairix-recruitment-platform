/**
 * Unit tests for `DecompositionResult` Zod schema (ADR-014 §2).
 *
 * The schema is also fed to OpenAI as `response_format: json_schema`
 * (ADR-014 §3). These tests pin the local contract so that a silent
 * drift between the prompt schema and the local parser is caught.
 */
import { describe, expect, it } from 'vitest';

import {
  DecompositionResultSchema,
  RequirementSchema,
  LanguageSchema,
  SeniorityEnum,
  RequirementCategoryEnum,
  LanguageLevelEnum,
} from './types';

function validRequirement() {
  return {
    skill_raw: 'Node.js',
    min_years: 3,
    max_years: null,
    must_have: true,
    evidence_snippet: '3+ años de Node.js',
    category: 'technical' as const,
  };
}

function validLanguage() {
  return {
    name: 'Inglés',
    level: 'intermediate' as const,
    must_have: false,
  };
}

function validResult() {
  return {
    requirements: [validRequirement()],
    seniority: 'senior' as const,
    languages: [validLanguage()],
    notes: 'Full-time, CABA',
  };
}

describe('SeniorityEnum', () => {
  it('accepts every level of the ADR-014 §2 enum', () => {
    const levels = ['junior', 'semi_senior', 'senior', 'lead', 'unspecified'];
    for (const l of levels) expect(SeniorityEnum.parse(l)).toBe(l);
  });

  it('rejects unknown seniority strings', () => {
    expect(() => SeniorityEnum.parse('principal')).toThrow();
  });
});

describe('RequirementCategoryEnum', () => {
  it('accepts every category of the ADR-014 §2 enum', () => {
    for (const c of ['technical', 'language', 'soft', 'other']) {
      expect(RequirementCategoryEnum.parse(c)).toBe(c);
    }
  });

  it('rejects unknown categories (silent drift guard)', () => {
    expect(() => RequirementCategoryEnum.parse('hard-skill')).toThrow();
  });
});

describe('LanguageLevelEnum', () => {
  it('accepts every level', () => {
    for (const l of ['basic', 'intermediate', 'advanced', 'native', 'unspecified']) {
      expect(LanguageLevelEnum.parse(l)).toBe(l);
    }
  });
});

describe('RequirementSchema', () => {
  it('parses a valid requirement', () => {
    expect(RequirementSchema.parse(validRequirement())).toEqual(validRequirement());
  });

  it('accepts min_years and max_years as null', () => {
    const parsed = RequirementSchema.parse({
      ...validRequirement(),
      min_years: null,
      max_years: null,
    });
    expect(parsed.min_years).toBeNull();
    expect(parsed.max_years).toBeNull();
  });

  it('rejects negative years', () => {
    expect(() => RequirementSchema.parse({ ...validRequirement(), min_years: -1 })).toThrow();
  });

  it('rejects non-integer years', () => {
    expect(() => RequirementSchema.parse({ ...validRequirement(), min_years: 2.5 })).toThrow();
  });

  it('requires a non-empty evidence_snippet (ADR-014 §3 literal rule)', () => {
    expect(() =>
      RequirementSchema.parse({ ...validRequirement(), evidence_snippet: '' }),
    ).toThrow();
  });

  it('strips unknown keys (no .passthrough)', () => {
    const parsed = RequirementSchema.parse({
      ...validRequirement(),
      confidence: 0.9,
    } as unknown);
    expect(parsed).not.toHaveProperty('confidence');
  });
});

describe('LanguageSchema', () => {
  it('parses a valid language', () => {
    expect(LanguageSchema.parse(validLanguage())).toEqual(validLanguage());
  });

  it('rejects empty name', () => {
    expect(() => LanguageSchema.parse({ ...validLanguage(), name: '' })).toThrow();
  });

  it('strips unknown keys', () => {
    const parsed = LanguageSchema.parse({
      ...validLanguage(),
      proficiency_score: 0.8,
    } as unknown);
    expect(parsed).not.toHaveProperty('proficiency_score');
  });
});

describe('DecompositionResultSchema', () => {
  it('parses a valid result', () => {
    expect(DecompositionResultSchema.parse(validResult())).toEqual(validResult());
  });

  it('allows empty requirements and languages', () => {
    const parsed = DecompositionResultSchema.parse({
      requirements: [],
      seniority: 'unspecified',
      languages: [],
      notes: null,
    });
    expect(parsed.requirements).toEqual([]);
    expect(parsed.languages).toEqual([]);
    expect(parsed.notes).toBeNull();
  });

  it('accepts notes as null', () => {
    const parsed = DecompositionResultSchema.parse({ ...validResult(), notes: null });
    expect(parsed.notes).toBeNull();
  });

  it('strips unknown top-level keys (deterministic raw_output)', () => {
    const parsed = DecompositionResultSchema.parse({
      ...validResult(),
      extra_field: 'ignored',
    } as unknown);
    expect(parsed).not.toHaveProperty('extra_field');
  });

  it('rejects missing seniority', () => {
    const { seniority: _s, ...rest } = validResult();
    expect(() => DecompositionResultSchema.parse(rest)).toThrow();
  });

  it('rejects requirements that are not an array', () => {
    expect(() =>
      DecompositionResultSchema.parse({ ...validResult(), requirements: null }),
    ).toThrow();
  });
});
