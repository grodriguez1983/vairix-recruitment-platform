/**
 * Unit tests for `fetchEvidenceSnippets` (ADR-016 §2 — evidence panel).
 *
 * Pure service: for a single candidate + a list of skill slugs from
 * the job_query requirements, return the top N snippets per skill
 * from FTS over `files.parsed_text`. NO threshold — the evidence
 * panel shows whatever exists (the ranker already decided the
 * candidate deserves to be visible).
 *
 * Invariants under test:
 *   1. No FTS call when the skill list is empty.
 *   2. Snippets are grouped per skill_slug; only skills with hits
 *      appear as keys.
 *   3. Per-skill ordering is ts_rank desc, then snippet asc.
 *   4. At most `limit` snippets per skill (default EVIDENCE_SNIPPET_LIMIT).
 *   5. Cross-pollinated hits (queryFts returning hits for candidates
 *      or skills that were not requested) are discarded defensively.
 *   6. The result's `skill_slugs` list preserves the requested slugs
 *      verbatim (including those with zero hits) — the UI may want
 *      to show "React: no textual evidence found".
 */
import { describe, expect, it, vi } from 'vitest';

import {
  EVIDENCE_SNIPPET_LIMIT,
  fetchEvidenceSnippets,
  type ComplementarySignalsDeps,
  type EvidenceSnippetRow,
  type FtsHit,
} from './complementary-signals';

function deps(hits: FtsHit[]): ComplementarySignalsDeps {
  return {
    queryFts: vi.fn(async () => hits),
  };
}

describe('fetchEvidenceSnippets — ADR-016 §2', () => {
  it('returns empty map when the skill list is empty and does not call queryFts', async () => {
    const d = deps([]);
    const out = await fetchEvidenceSnippets({ candidate_id: 'cand-1', skill_slugs: [] }, d);
    expect(out.snippets).toEqual({});
    expect(d.queryFts).not.toHaveBeenCalled();
  });

  it('groups hits by skill_slug, descending by ts_rank then ascending by snippet', async () => {
    const d = deps([
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.2, snippet: 'z React app' },
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.5, snippet: 'built React' },
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.2, snippet: 'a React hook' },
      { candidate_id: 'cand-1', skill_slug: 'python', ts_rank: 0.3, snippet: 'Python scripts' },
    ]);
    const out: EvidenceSnippetRow = await fetchEvidenceSnippets(
      { candidate_id: 'cand-1', skill_slugs: ['react', 'python'] },
      d,
    );
    expect(out.candidate_id).toBe('cand-1');
    expect(out.snippets.react).toEqual(['built React', 'a React hook', 'z React app']);
    expect(out.snippets.python).toEqual(['Python scripts']);
  });

  it('caps snippets per skill at the provided limit (default EVIDENCE_SNIPPET_LIMIT)', async () => {
    const hits: FtsHit[] = [];
    for (let i = 0; i < EVIDENCE_SNIPPET_LIMIT + 3; i += 1) {
      hits.push({
        candidate_id: 'cand-1',
        skill_slug: 'react',
        ts_rank: 0.9 - i * 0.01, // strictly descending
        snippet: `snippet ${String(i).padStart(2, '0')}`,
      });
    }
    const d = deps(hits);
    const out = await fetchEvidenceSnippets({ candidate_id: 'cand-1', skill_slugs: ['react'] }, d);
    expect(out.snippets.react).toHaveLength(EVIDENCE_SNIPPET_LIMIT);
    // Top N after descending-by-rank sort
    expect(out.snippets.react?.[0]).toBe('snippet 00');
  });

  it('respects a custom per-skill limit option', async () => {
    const d = deps([
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.9, snippet: 'a' },
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.8, snippet: 'b' },
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.7, snippet: 'c' },
    ]);
    const out = await fetchEvidenceSnippets({ candidate_id: 'cand-1', skill_slugs: ['react'] }, d, {
      limit: 2,
    });
    expect(out.snippets.react).toEqual(['a', 'b']);
  });

  it('discards cross-pollinated hits (wrong candidate or wrong skill)', async () => {
    const d = deps([
      { candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.5, snippet: 'ok' },
      { candidate_id: 'cand-2', skill_slug: 'react', ts_rank: 0.9, snippet: 'wrong candidate' },
      { candidate_id: 'cand-1', skill_slug: 'golang', ts_rank: 0.9, snippet: 'wrong skill' },
    ]);
    const out = await fetchEvidenceSnippets(
      { candidate_id: 'cand-1', skill_slugs: ['react', 'python'] },
      d,
    );
    expect(Object.keys(out.snippets).sort()).toEqual(['react']);
    expect(out.snippets.react).toEqual(['ok']);
  });

  it('dedupes skill slugs before calling queryFts', async () => {
    const query: ComplementarySignalsDeps['queryFts'] = vi.fn(async () => []);
    await fetchEvidenceSnippets(
      { candidate_id: 'cand-1', skill_slugs: ['react', 'react', 'python'] },
      { queryFts: query },
    );
    expect(query).toHaveBeenCalledTimes(1);
    const arg = (query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { candidateIds: string[]; skillSlugs: string[] }
      | undefined;
    expect(arg?.candidateIds).toEqual(['cand-1']);
    expect([...(arg?.skillSlugs ?? [])].sort()).toEqual(['python', 'react']);
  });

  it('does not include a key for skills without any hit', async () => {
    const d = deps([{ candidate_id: 'cand-1', skill_slug: 'react', ts_rank: 0.5, snippet: 'hit' }]);
    const out = await fetchEvidenceSnippets(
      { candidate_id: 'cand-1', skill_slugs: ['react', 'rust'] },
      d,
    );
    expect(Object.keys(out.snippets)).toEqual(['react']);
  });
});
