/**
 * Profile source builder for the embeddings pipeline (ADR-005
 * §Fuentes a embeber).
 *
 * Produces a synthetic text representation of a candidate for
 * semantic retrieval when no CV or notes have been indexed yet.
 * Shape: `"<first> <last> — <headline>\n<summary>\nTags: a, b, c"`,
 * with sections omitted when their fields are empty.
 *
 * Determinism matters: this string is hashed, and any instability
 * (tag ordering, whitespace quirks) would flood the content_hash
 * cache with false misses and trigger unnecessary regeneration. We
 * sort tags alphabetically and collapse internal whitespace.
 *
 * Returns null when there is literally nothing to embed — callers
 * should skip the row rather than hash an empty string.
 */
export interface ProfileSourceInput {
  candidateId: string;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  summary: string | null;
  tags: readonly string[];
}

function cleanString(v: string | null): string {
  if (v === null) return '';
  return v.replace(/\s+/g, ' ').trim();
}

export function buildProfileContent(input: ProfileSourceInput): string | null {
  const first = cleanString(input.firstName);
  const last = cleanString(input.lastName);
  const headline = cleanString(input.headline);
  const summary = cleanString(input.summary);
  const tags = [...input.tags]
    .map((t) => cleanString(t))
    .filter((t) => t.length > 0)
    .sort((a, b) => a.localeCompare(b, 'en'));

  const name = [first, last].filter((s) => s.length > 0).join(' ');

  const nameLine =
    name.length > 0 && headline.length > 0
      ? `${name} — ${headline}`
      : name.length > 0
        ? name
        : headline;

  const parts: string[] = [];
  if (nameLine && nameLine.length > 0) parts.push(nameLine);
  if (summary.length > 0) parts.push(summary);
  if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);

  if (parts.length === 0) return null;
  return parts.join('\n');
}
