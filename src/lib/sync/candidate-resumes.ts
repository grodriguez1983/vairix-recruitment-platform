/**
 * Candidate-resume downloader (ADR-018) — STUB.
 *
 * Contract-only stub so the [RED] test commit typechecks. The real
 * implementation lands in the next [GREEN] commit.
 *
 * Teamtailor exposes two CV surfaces:
 *   - /v1/uploads → explicit recruiter/candidate uploads (uploads
 *     syncer already handles this).
 *   - candidates.attributes.resume → short-lived (~60s) S3 signed
 *     URL to a TT-generated PDF. For sourced candidates this is the
 *     ONLY CV artifact available.
 *
 * This module will persist the latter as a `files` row with
 * `source='candidate_resume'`. The `teamtailor_id` is namespaced
 * with a `resume:` prefix so it cannot collide with numeric upload
 * ids (the uploads table's PK domain).
 */
import type { StorageBucketLike } from '../cv/downloader';

export interface CandidateResumeDeps {
  fetch: typeof fetch;
  storage: StorageBucketLike;
  randomUuid: () => string;
}

export interface CandidateResumeInput {
  candidate_tt_id: string;
  resume_url: string | null;
}

export interface CandidateResumeResult {
  attempted: number;
  upserted: number;
  skippedNoUrl: number;
  errors: number;
}

export function resumeTeamtailorId(_candidateTtId: string): string {
  // Stub: intentionally wrong so the test drives the real impl.
  return '';
}

export function resumeFileName(_candidateTtId: string): string {
  // Stub.
  return '';
}

export async function downloadResumesForCandidates(
  _inputs: CandidateResumeInput[],
  _candidateIdByTtId: Map<string, string>,
  _db: unknown,
  _deps: CandidateResumeDeps,
): Promise<CandidateResumeResult> {
  // Stub — always reports a no-op; real impl in [GREEN].
  return { attempted: 0, upserted: 0, skippedNoUrl: 0, errors: 0 };
}
