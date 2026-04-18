/**
 * Pure classifier for rejection reasons (ADR-007 §3).
 *
 * Given a free-text reason, returns the first rule (by priority
 * ascending) whose keywords appear as substring matches in the
 * lowercased input. When nothing matches, returns the 'other'
 * fallback with `needsReview=true` so the admin review queue
 * (§5) can pick it up.
 *
 * This function is pure: no DB, no network, no time dependency.
 * The rules table in `./rejection-rules` is the only input.
 */
import { FALLBACK_CODE, REJECTION_RULES } from './rejection-rules';

export interface ClassifyResult {
  code: string;
  /** True only when the fallback was used (`other`). */
  needsReview: boolean;
}

function isNonEmpty(reason: string | null): reason is string {
  return reason !== null && reason.trim().length > 0;
}

export function classifyRejectionReason(reason: string | null): ClassifyResult | null {
  if (!isNonEmpty(reason)) return null;
  const haystack = reason.toLowerCase();

  // Rules are already declared in priority order, but sort defensively
  // so the ordering contract doesn't depend on array layout.
  const sorted = [...REJECTION_RULES].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        return { code: rule.code, needsReview: false };
      }
    }
  }
  return { code: FALLBACK_CODE, needsReview: true };
}
