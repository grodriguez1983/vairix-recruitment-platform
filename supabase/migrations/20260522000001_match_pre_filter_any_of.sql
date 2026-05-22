-- ADR-036 — Soft union pre-filter gate.
--
-- Extends `match_pre_filter` with a third arg `any_of_skill_ids_in
-- uuid[]` that, when non-null and non-empty, restricts the
-- visible candidate pool to those with at least one
-- `experience_skills` row in the array. The previous semantics is
-- preserved: passing null/empty for the third arg behaves
-- identically to the two-arg version. This is the SQL mirror of
-- `preFilterByMustHave` (src/lib/matching/pre-filter.ts).
--
-- The two-arg signature is dropped first so we keep a single
-- callable for the matching pipeline (otherwise PostgREST would
-- pick by argument-count and a stale caller could bypass the gate).
-- The previous timeout override (migration 20260521000003) only
-- targets the dropped signature, so it's re-attached at the end.

drop function if exists public.match_pre_filter(jsonb, uuid);

create or replace function public.match_pre_filter(
  must_have_groups_in jsonb,
  tenant_id_in uuid,
  any_of_skill_ids_in uuid[] default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  result jsonb;
  -- `array_length` returns NULL for both NULL and empty arrays;
  -- COALESCE folds both into 0 so the boolean is always
  -- 3-valued-logic-safe (no NULL contagion downstream).
  any_of_active boolean := coalesce(array_length(any_of_skill_ids_in, 1), 0) > 0;
  groups_active boolean := must_have_groups_in is not null
    and jsonb_array_length(must_have_groups_in) > 0;
begin
  -- Both gates inactive — full (tenant-visible) pool included.
  if not any_of_active and not groups_active then
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
    -- Gate 2 source set (ADR-036). When inactive we still need a
    -- placeholder so the rest of the CTE chain can reference it
    -- uniformly; we materialize it as the full tenant-visible pool.
    visible_candidates as (
      select c.id
      from candidates c
      where (tenant_id_in is null or c.tenant_id = tenant_id_in)
        and (
          not any_of_active
          or exists (
            select 1
            from experience_skills es
            join candidate_experiences ce on ce.id = es.experience_id
            where ce.candidate_id = c.id
              and es.skill_id = any(any_of_skill_ids_in)
          )
        )
    ),
    groups as (
      select (ordinality - 1)::int as group_idx,
             array(select jsonb_array_elements_text(g->'skill_ids'))::uuid[] as skill_ids
      from jsonb_array_elements(coalesce(must_have_groups_in, '[]'::jsonb))
        with ordinality as t(g, ordinality)
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

comment on function public.match_pre_filter(jsonb, uuid, uuid[]) is
  'ADR-036 §RPC #1. Server-side pre-filter: must-have groups (gate 1) + soft union (gate 2). Mirrors preFilterByMustHave in src/lib/matching/pre-filter.ts.';

-- Re-attach the per-function statement_timeout override
-- (ADR-033 follow-up, see migration 20260521000003).
alter function public.match_pre_filter(jsonb, uuid, uuid[])
  set statement_timeout = '60s';
