-- ADR-033 follow-up — rewrite `match_load_aggregates` to use
-- set-based CTE aggregation instead of per-candidate correlated
-- subqueries.
--
-- Symptom (2026-05-21, prod ~8 700 cands): the v1 definition
-- (20260521000001) hit `canceling statement due to statement
-- timeout`. The planner executed the per-candidate `jsonb_agg(...)`
-- subqueries as a nested loop of ~8 700 outer iterations × 2 inner
-- aggregations, blowing past the 60 s service_role timeout despite
-- proper FK indexes existing.
--
-- The CTE pattern below is one-pass-per-table:
--   1. exp_skills      — group experience_skills by experience_id
--                        (one hash-aggregate over the rows whose
--                        experience belongs to a visible candidate).
--   2. experiences_per_candidate — left-join (1) into
--                        candidate_experiences, group by candidate_id.
--   3. languages_per_candidate — group candidate_languages by
--                        candidate_id.
--   4. Final select   — left-join (2) and (3) into the visible
--                        candidates and `jsonb_agg` the rows.
-- The planner can pick hash joins between the CTEs because every
-- join key is a single equality on an indexed column.
--
-- Contract unchanged: same input args, same JSONB output shape.
-- ADR-033 §RPC #2 integration tests stay GREEN (7/7).

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
  with
    visible as (
      select c.id
      from candidates c
      where c.id = any(candidate_ids_in)
        and (tenant_id_in is null or c.tenant_id = tenant_id_in)
    ),
    visible_experiences as (
      select ce.id, ce.candidate_id, ce.source_variant, ce.kind,
             ce.company, ce.title, ce.start_date, ce.end_date,
             ce.description
      from candidate_experiences ce
      where ce.candidate_id in (select id from visible)
    ),
    exp_skills as (
      select es.experience_id,
             jsonb_agg(jsonb_build_object(
               'skill_id', es.skill_id,
               'skill_raw', es.skill_raw
             )) as skills
      from experience_skills es
      where es.experience_id in (select id from visible_experiences)
      group by es.experience_id
    ),
    experiences_per_candidate as (
      select ve.candidate_id,
             jsonb_agg(jsonb_build_object(
               'id', ve.id,
               'source_variant', ve.source_variant,
               'kind', ve.kind,
               'company', ve.company,
               'title', ve.title,
               'start_date', ve.start_date,
               'end_date', ve.end_date,
               'description', ve.description,
               'skills', coalesce(es.skills, '[]'::jsonb)
             )) as experiences
      from visible_experiences ve
      left join exp_skills es on es.experience_id = ve.id
      group by ve.candidate_id
    ),
    languages_per_candidate as (
      select cl.candidate_id,
             jsonb_agg(jsonb_build_object(
               'name', cl.name,
               'level', cl.level
             )) as languages
      from candidate_languages cl
      where cl.candidate_id in (select id from visible)
      group by cl.candidate_id
    )
  select coalesce(jsonb_agg(jsonb_build_object(
    'candidate_id', v.id,
    'experiences', coalesce(epc.experiences, '[]'::jsonb),
    'languages', coalesce(lpc.languages, '[]'::jsonb)
  )), '[]'::jsonb)
  from visible v
  left join experiences_per_candidate epc on epc.candidate_id = v.id
  left join languages_per_candidate lpc on lpc.candidate_id = v.id;
$$;

comment on function public.match_load_aggregates(uuid[], uuid) is
  'ADR-033 §RPC #2 (v2, CTE-based). Server-side candidate aggregate loader. Set-based aggregation; replaces the v1 correlated-subquery body that timed out at ~8 700 candidates in prod.';
