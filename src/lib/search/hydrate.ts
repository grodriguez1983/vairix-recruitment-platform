/**
 * Hydration helper for semantic / hybrid search results.
 *
 * The search API surfaces only candidate ids + scores; the UI needs
 * names, emails, pitches, etc. to render cards. This loader fetches
 * those fields through the RLS-scoped client so a recruiter never
 * sees a candidate they aren't allowed to.
 *
 * Returns the rows in the *same order* as the input ids — relevance
 * order is determined by the search caller, not the database.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SearchResultCandidate } from './types';

interface RawCandidate {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  pitch: string | null;
  linkedin_url: string | null;
}

export async function hydrateCandidatesByIds(
  db: SupabaseClient,
  ids: readonly string[],
): Promise<SearchResultCandidate[]> {
  if (ids.length === 0) return [];

  const { data, error } = await db
    .from('candidates')
    .select('id, first_name, last_name, email, pitch, linkedin_url')
    .in('id', [...ids]);
  if (error) throw new Error(`hydrate candidates failed: ${error.message}`);

  const byId = new Map<string, SearchResultCandidate>();
  for (const row of (data ?? []) as RawCandidate[]) {
    byId.set(row.id, {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      pitch: row.pitch,
      linkedinUrl: row.linkedin_url,
    });
  }

  // Preserve caller-provided order; drop ids the RLS-scoped query
  // didn't return (recruiter not allowed to see, or row deleted).
  const out: SearchResultCandidate[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}
