/**
 * Rejection-reason classifier — stub.
 *
 * Real implementation lands in the [GREEN] commit per TDD
 * discipline (ADR-007 §3). This stub exists so the test file
 * typechecks in the [RED] commit.
 */

export interface ClassifyResult {
  code: string;
  needsReview: boolean;
}

export function classifyRejectionReason(_reason: string | null): ClassifyResult | null {
  throw new Error('not implemented');
}
