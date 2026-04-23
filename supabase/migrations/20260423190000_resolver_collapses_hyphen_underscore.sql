-- Migration: ADR-024 — normalizer collapses `-`/`_` between alphanumerics
-- Depends on: 20260420000000_skills_catalog (defines resolve_skill + aliases)
-- Ref: docs/adr/adr-024-normalizer-collapses-hyphen-underscore.md
-- Rollback (manual):
--   1. Restore resolve_skill body from 20260420000000 (no hyphen step).
--   2. UPDATE skill_aliases SET alias_normalized = 'c-sharp'   WHERE ...
--                                   'ci-cd', 'gitlab-ci' — reverse the
--      UPDATE below. Original values are preserved by the commit history.
--   3. experience_skills.skill_id rows newly filled cannot be reverted
--      cleanly without knowing which were NULL before — acceptable
--      because the values are DERIVED (resolve_skill is idempotent),
--      so re-running resolve_skill on a restored resolver reproduces
--      the prior state.

-- ────────────────────────────────────────────────────────────────
-- 1. resolve_skill — add hyphen/underscore collapse step
-- ────────────────────────────────────────────────────────────────
-- Mirror of src/lib/skills/resolver.ts:normalizeSkillInput step 4.
-- Pattern: `([a-z0-9])[-_](?=[a-z0-9])` → `\1 `. Lookahead (non-
-- consuming) handles `a-b-c` in one pass. Postgres supports
-- lookahead under AREs (default flavor).
create or replace function public.resolve_skill(raw text)
returns uuid
language plpgsql
stable
as $$
declare
  normalized text;
  result_id  uuid;
begin
  normalized := regexp_replace(raw, '^\s+|\s+$', '', 'g');
  if normalized is null or length(normalized) = 0 then
    return null;
  end if;

  normalized := lower(normalized);
  normalized := regexp_replace(normalized, '\s+', ' ', 'g');

  -- ADR-024: collapse `-` and `_` between alphanumerics to a single
  -- space. "react-native" → "react native". Keeps non-alphanum
  -- internal punctuation (node.js, c++, c#, ci/cd) untouched.
  normalized := regexp_replace(
    normalized,
    '([a-z0-9])[-_](?=[a-z0-9])',
    '\1 ',
    'g'
  );

  normalized := regexp_replace(normalized, '[.,;:]+$', '');

  select id into result_id
    from skills
   where slug = normalized
     and deprecated_at is null;
  if result_id is not null then
    return result_id;
  end if;

  select skill_id into result_id
    from skill_aliases
   where alias_normalized = normalized;

  return result_id;
end;
$$;

comment on function public.resolve_skill(text) is
  'Resolves a raw skill string to skills.id per ADR-013 §2 + ADR-024. '
  'Returns null when uncataloged. Mirror of src/lib/skills/resolver.ts.';

-- ────────────────────────────────────────────────────────────────
-- 2. Re-normalize existing aliases with hyphen between alphanumerics
-- ────────────────────────────────────────────────────────────────
-- Before ADR-024 three aliases were stored with literal hyphens:
--   c-sharp  → C# (slug "c#")
--   ci-cd    → CI/CD (slug "ci/cd")
--   gitlab-ci → GitLab CI (slug "gitlab ci")
-- After ADR-024 inputs like "c-sharp" normalize to "c sharp" before
-- lookup, so the stored form must match the normalized form or the
-- alias is dead. Verified pre-migration that the normalized forms
-- do NOT collide with any existing alias_normalized row.
update skill_aliases
   set alias_normalized = regexp_replace(
     alias_normalized, '([a-z0-9])[-_](?=[a-z0-9])', '\1 ', 'g'
   )
 where alias_normalized ~ '[a-z0-9][-_][a-z0-9]';

-- ────────────────────────────────────────────────────────────────
-- 3. Backfill experience_skills.skill_id where resolver now resolves
-- ────────────────────────────────────────────────────────────────
-- Before ADR-024 any CV extraction that wrote skill_raw with a hyphen
-- between alphanumerics (`React-Native`, `styled-components`,
-- `material-ui`, etc.) ended up with skill_id = NULL because the
-- resolver couldn't bridge the hyphen form to the slug. Re-running
-- resolve_skill over the NULL rows recovers them in place without
-- re-doing the CV extraction.
--
-- The operation is idempotent: rows where resolve_skill still returns
-- null stay null. No previously-resolved row is touched (WHERE
-- skill_id IS NULL guards that).
update experience_skills
   set skill_id = public.resolve_skill(skill_raw)
 where skill_id is null
   and public.resolve_skill(skill_raw) is not null;
