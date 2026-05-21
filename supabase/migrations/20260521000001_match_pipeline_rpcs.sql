-- ADR-033 — Server-side matching pipeline RPCs.
--
-- Two stable, security-invoker plpgsql/sql functions returning jsonb
-- scalars (one row, one body) so PostgREST does NOT apply
-- max_rows=1000 to them. RLS is preserved because of security
-- invoker.
--
-- See docs/adr/adr-033-server-side-rpc-matching-pipeline.md.

-- ---------------------------------------------------------------
-- RPC #1 — match_pre_filter
--
-- Replaces the JS preFilterByMustHave (src/lib/matching/pre-filter.ts).
-- Input: array of must-have groups, each `{ "skill_ids": [uuid,...] }`.
--        Within a group: OR (any one of the skills covers the group).
--        Across groups: AND (every group must be covered).
-- Output: `{ included: uuid[], excluded: [{ candidate_id, missing_must_have_skill_ids }] }`.
-- Empty groups input → every (tenant-visible) candidate included.
-- ---------------------------------------------------------------
create or replace function public.match_pre_filter(
  must_have_groups_in jsonb,
  tenant_id_in uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  result jsonb;
begin
  -- Empty input → all (tenant-visible) candidates included.
  if must_have_groups_in is null or jsonb_array_length(must_have_groups_in) = 0 then
    select jsonb_build_object(
      'included', coalesce(jsonb_agg(c.id), '[]'::jsonb),
      'excluded', '[]'::jsonb
    )
    into result
    from candidates c
    where tenant_id_in is null or c.tenant_id = tenant_id_in;
    return result;
  end if;

  with
    groups as (
      select (ordinality - 1)::int as group_idx,
             array(select jsonb_array_elements_text(g->'skill_ids'))::uuid[] as skill_ids
      from jsonb_array_elements(must_have_groups_in) with ordinality as t(g, ordinality)
    ),
    visible_candidates as (
      select c.id
      from candidates c
      where tenant_id_in is null or c.tenant_id = tenant_id_in
    ),
    candidate_group_hits as (
      select distinct ce.candidate_id, g.group_idx
      from experience_skills es
      join candidate_experiences ce on ce.id = es.experience_id
      join groups g on es.skill_id = any(g.skill_ids)
      where ce.candidate_id in (select id from visible_candidates)
    ),
    covered_count_per_candidate as (
      select vc.id as candidate_id,
             coalesce(count(distinct cgh.group_idx), 0) as covered_count
      from visible_candidates vc
      left join candidate_group_hits cgh on cgh.candidate_id = vc.id
      group by vc.id
    ),
    total_groups as (
      select count(*)::int as n from groups
    ),
    missing_per_excluded as (
      select cc.candidate_id,
             coalesce(jsonb_agg(distinct s.skill_id), '[]'::jsonb) as missing
      from covered_count_per_candidate cc
      cross join total_groups tg
      left join lateral (
        select unnest(g.skill_ids) as skill_id
        from groups g
        where g.group_idx not in (
          select group_idx from candidate_group_hits
          where candidate_id = cc.candidate_id
        )
      ) s on true
      where cc.covered_count < tg.n
      group by cc.candidate_id
    )
  select jsonb_build_object(
    'included', coalesce((
      select jsonb_agg(cc.candidate_id)
      from covered_count_per_candidate cc
      cross join total_groups tg
      where cc.covered_count = tg.n
    ), '[]'::jsonb),
    'excluded', coalesce((
      select jsonb_agg(jsonb_build_object(
        'candidate_id', m.candidate_id,
        'missing_must_have_skill_ids', m.missing
      ))
      from missing_per_excluded m
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

comment on function public.match_pre_filter(jsonb, uuid) is
  'ADR-033 §RPC #1. Server-side must-have pre-filter. Mirrors preFilterByMustHave in src/lib/matching/pre-filter.ts.';

-- ---------------------------------------------------------------
-- RPC #2 — match_load_aggregates
--
-- Replaces JS loadExperiences + loadLanguages
-- (src/lib/matching/load-candidate-aggregates.ts). One JSONB array
-- with `{ candidate_id, experiences[], languages[] }` per requested
-- candidate. `mergeVariants` (ADR-015) stays in TS.
-- ---------------------------------------------------------------
create or replace function public.match_load_aggregates(
  candidate_ids_in uuid[],
  tenant_id_in uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(payload), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'candidate_id', c.id,
      'experiences', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', ce.id,
          'source_variant', ce.source_variant,
          'kind', ce.kind,
          'company', ce.company,
          'title', ce.title,
          'start_date', ce.start_date,
          'end_date', ce.end_date,
          'description', ce.description,
          'skills', coalesce((
            select jsonb_agg(jsonb_build_object('skill_id', es.skill_id, 'skill_raw', es.skill_raw))
            from experience_skills es
            where es.experience_id = ce.id
          ), '[]'::jsonb)
        ))
        from candidate_experiences ce
        where ce.candidate_id = c.id
      ), '[]'::jsonb),
      'languages', coalesce((
        select jsonb_agg(jsonb_build_object('name', cl.name, 'level', cl.level))
        from candidate_languages cl
        where cl.candidate_id = c.id
      ), '[]'::jsonb)
    ) as payload
    from candidates c
    where c.id = any(candidate_ids_in)
      and (tenant_id_in is null or c.tenant_id = tenant_id_in)
  ) as agg;
$$;

comment on function public.match_load_aggregates(uuid[], uuid) is
  'ADR-033 §RPC #2. Server-side candidate aggregate loader. Mirrors loadExperiences + loadLanguages in src/lib/matching/load-candidate-aggregates.ts.';
