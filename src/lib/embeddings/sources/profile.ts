/**
 * Profile source builder for the embeddings pipeline (ADR-005).
 * Stub — [GREEN] commit fills it in.
 */
export interface ProfileSourceInput {
  candidateId: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  summary: string | null;
  tags: readonly string[];
}

export function buildProfileContent(_input: ProfileSourceInput): string | null {
  throw new Error('not implemented');
}
