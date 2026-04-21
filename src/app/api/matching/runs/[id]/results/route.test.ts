/**
 * Adversarial tests for GET /api/matching/runs/:id/results query
 * pagination schema (F4-008 sub-D).
 */
import { describe, expect, it } from 'vitest';

import { resultsQuerySchema } from './route';

describe('resultsQuerySchema', () => {
  it('accepts empty query → defaults (offset=0, limit=50)', () => {
    const parsed = resultsQuerySchema.parse({});
    expect(parsed).toEqual({ offset: 0, limit: 50 });
  });

  it('coerces numeric strings', () => {
    const parsed = resultsQuerySchema.parse({ offset: '10', limit: '25' });
    expect(parsed).toEqual({ offset: 10, limit: 25 });
  });

  it('rejects offset < 0', () => {
    expect(() => resultsQuerySchema.parse({ offset: '-1' })).toThrow();
  });

  it('rejects limit < 1', () => {
    expect(() => resultsQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('rejects limit > 200 (hard ceiling)', () => {
    expect(() => resultsQuerySchema.parse({ limit: '201' })).toThrow();
  });

  it('rejects non-numeric values', () => {
    expect(() => resultsQuerySchema.parse({ offset: 'abc' })).toThrow();
    expect(() => resultsQuerySchema.parse({ limit: 'xyz' })).toThrow();
  });

  it('rejects non-integer values', () => {
    expect(() => resultsQuerySchema.parse({ limit: '3.5' })).toThrow();
  });
});
