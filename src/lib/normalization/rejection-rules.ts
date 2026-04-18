/**
 * Versioned keyword rules for rejection-reason normalization (ADR-007 §3).
 *
 * Rules are ordered by `priority` ascending (lower wins). The `code`
 * must match a row in `rejection_categories.code` (seeded by
 * migration 20260417205206_rejection_categories.sql).
 *
 * Keywords are matched case-insensitively against the raw reason
 * text. They are not anchored — a substring match is enough. Keep
 * keywords specific: "technical" by itself is fine, "skill" alone
 * is too broad (would grab "soft skill communication").
 *
 * ES + EN variants live side by side. When adding a keyword,
 * prefer phrases over single words when ambiguity is possible.
 */
export interface RejectionRule {
  code: string;
  priority: number;
  keywords: readonly string[];
}

export const REJECTION_RULES: readonly RejectionRule[] = [
  {
    code: 'technical_skills',
    priority: 10,
    keywords: [
      'technical',
      'nivel técnico',
      'skills técnicas',
      'coding',
      'algorithm',
      'algoritmo',
      'data structure',
      'estructuras de datos',
      'knowledge gap',
      'falta de conocimientos',
    ],
  },
  {
    code: 'experience_level',
    priority: 20,
    keywords: [
      'seniority',
      'not senior enough',
      'too junior',
      'too senior',
      'años de experiencia',
      'seniority no encaja',
      'experience level',
    ],
  },
  {
    code: 'communication',
    priority: 30,
    keywords: [
      'communication',
      'comunicación',
      'inglés',
      'english level',
      'hard to understand',
      'poco claro',
    ],
  },
  {
    code: 'culture_fit',
    priority: 40,
    keywords: ['culture fit', 'cultural fit', 'no fit cultural', 'no encaja culturalmente'],
  },
  {
    code: 'salary_expectations',
    priority: 50,
    keywords: [
      'salary',
      'expectativa salarial',
      'pretensión',
      'out of budget',
      'fuera de presupuesto',
      'comp expectations',
    ],
  },
  {
    code: 'availability',
    priority: 60,
    keywords: [
      'availability',
      'disponibilidad',
      'not available',
      'cannot start',
      'can’t start',
      "can't start",
    ],
  },
  {
    code: 'location',
    priority: 70,
    keywords: ['time zone', 'timezone', 'ubicación', 'location mismatch', 'relocation'],
  },
  {
    code: 'no_show',
    priority: 80,
    keywords: ['no show', 'no-show', 'did not show up', 'no se presentó'],
  },
  {
    code: 'ghosting',
    priority: 90,
    keywords: ['ghosting', 'ghosted', 'dejó de responder', 'stopped responding'],
  },
  {
    code: 'position_filled',
    priority: 100,
    keywords: [
      'position filled',
      'posición cubierta',
      'role filled',
      'hired someone else',
      'cubrimos la posición',
    ],
  },
];

/** Category code used when no keyword rule matches. */
export const FALLBACK_CODE = 'other';
