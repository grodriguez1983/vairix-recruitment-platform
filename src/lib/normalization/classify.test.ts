/**
 * Unit tests for the rejection-reason classifier (ADR-007 §3).
 *
 * The classifier is a pure function over the versioned rules table
 * — no DB, no network. Tests live next to the implementation so the
 * module can be refactored as a unit.
 */
import { describe, expect, it } from 'vitest';

import { classifyRejectionReason } from './classify';

describe('classifyRejectionReason', () => {
  describe('null / empty input', () => {
    it('returns null for null input', () => {
      expect(classifyRejectionReason(null)).toBeNull();
    });
    it('returns null for empty string', () => {
      expect(classifyRejectionReason('')).toBeNull();
    });
    it('returns null for whitespace-only', () => {
      expect(classifyRejectionReason('   \n\t')).toBeNull();
    });
  });

  describe('technical_skills', () => {
    it('matches english "technical"', () => {
      const res = classifyRejectionReason('Technical skills below bar');
      expect(res?.code).toBe('technical_skills');
    });
    it('matches spanish "nivel técnico"', () => {
      const res = classifyRejectionReason('Nivel técnico insuficiente');
      expect(res?.code).toBe('technical_skills');
    });
    it('is case-insensitive', () => {
      const res = classifyRejectionReason('ALGORITHM knowledge gap');
      expect(res?.code).toBe('technical_skills');
    });
  });

  describe('communication', () => {
    it('matches english "communication"', () => {
      expect(classifyRejectionReason('Communication issues')?.code).toBe('communication');
    });
    it('matches spanish "inglés"', () => {
      expect(classifyRejectionReason('Nivel de inglés bajo')?.code).toBe('communication');
    });
  });

  describe('salary_expectations', () => {
    it('matches "salary"', () => {
      expect(classifyRejectionReason('Salary above our range')?.code).toBe('salary_expectations');
    });
    it('matches "pretensión"', () => {
      expect(classifyRejectionReason('Pretensión salarial muy alta')?.code).toBe(
        'salary_expectations',
      );
    });
    it('matches "out of budget"', () => {
      expect(classifyRejectionReason('Out of budget for this role')?.code).toBe(
        'salary_expectations',
      );
    });
  });

  describe('availability', () => {
    it('matches "availability"', () => {
      expect(classifyRejectionReason('Availability mismatch')?.code).toBe('availability');
    });
  });

  describe('location', () => {
    it('matches "time zone"', () => {
      expect(classifyRejectionReason('Time zone too far off')?.code).toBe('location');
    });
    it('matches "ubicación"', () => {
      expect(classifyRejectionReason('Ubicación incompatible')?.code).toBe('location');
    });
  });

  describe('no_show / ghosting', () => {
    it('matches "no show"', () => {
      expect(classifyRejectionReason('Candidate no-show at interview')?.code).toBe('no_show');
    });
    it('matches "dejó de responder"', () => {
      expect(classifyRejectionReason('Dejó de responder mensajes')?.code).toBe('ghosting');
    });
  });

  describe('position_filled', () => {
    it('matches "position filled"', () => {
      expect(classifyRejectionReason('Position filled by another candidate')?.code).toBe(
        'position_filled',
      );
    });
    it('matches "posición cubierta"', () => {
      expect(classifyRejectionReason('Posición cubierta internamente')?.code).toBe(
        'position_filled',
      );
    });
  });

  describe('unmatched', () => {
    it('returns a fallback result with code=other and needsReview=true', () => {
      const res = classifyRejectionReason('La vibra no coincidía con el equipo');
      expect(res).not.toBeNull();
      expect(res?.code).toBe('other');
      expect(res?.needsReview).toBe(true);
    });

    it('never flags needsReview when a keyword matched', () => {
      const res = classifyRejectionReason('Technical skills not enough');
      expect(res?.needsReview).toBe(false);
    });
  });

  describe('priority', () => {
    it('first matching rule wins — salary before availability if both appear', () => {
      // "salary" is priority 50, "availability" is 60; salary wins.
      const res = classifyRejectionReason('Salary and availability both off');
      expect(res?.code).toBe('salary_expectations');
    });
  });
});
