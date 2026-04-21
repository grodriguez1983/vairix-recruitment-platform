/**
 * Variant merger (ADR-015 §2, F4-007 sub-A). Placeholder for RED.
 */
import type { ExperienceInput, MergeResult } from './types';

export interface MergeOptions {
  now?: Date;
}

export function mergeVariants(_input: ExperienceInput[], _options: MergeOptions = {}): MergeResult {
  throw new Error('not implemented');
}
