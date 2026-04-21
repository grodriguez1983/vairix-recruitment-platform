/**
 * Years-for-skill sweep-line calculator (ADR-015 §1, F4-007 sub-B).
 * RED placeholder.
 */
import type { MergedExperience } from './types';

export interface YearsOptions {
  now?: Date;
}

export function yearsForSkill(
  _skillId: string,
  _experiences: readonly MergedExperience[],
  _options: YearsOptions = {},
): number {
  throw new Error('not implemented');
}
