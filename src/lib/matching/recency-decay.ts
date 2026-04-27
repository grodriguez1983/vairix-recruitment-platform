/**
 * Recency decay on skill years (ADR-026).
 *
 * STUB ONLY — RED phase. The implementation arrives in the GREEN
 * commit; this file exists so the test suite typechecks while the
 * tests fail on behavior, not on missing module.
 */
import type { MergedExperience } from './types';

export const HALF_LIFE_YEARS = 4;

export interface EffectiveYearsResult {
  rawYears: number;
  effectiveYears: number;
  lastUsed: Date | null;
  yearsSinceLastUse: number;
  decayFactor: number;
}

export interface EffectiveYearsOptions {
  asOf: Date;
  halfLifeYears?: number;
}

export function decayFactor(_yearsSinceLastUse: number, _halfLife?: number): number {
  return 0;
}

export function lastUsedFor(
  _skillId: string,
  _experiences: readonly MergedExperience[],
  _asOf: Date,
): Date | null {
  return null;
}

export function effectiveYearsForSkill(
  _skillId: string,
  _experiences: readonly MergedExperience[],
  _options: EffectiveYearsOptions,
): EffectiveYearsResult {
  return {
    rawYears: 0,
    effectiveYears: 0,
    lastUsed: null,
    yearsSinceLastUse: 0,
    decayFactor: 0,
  };
}
