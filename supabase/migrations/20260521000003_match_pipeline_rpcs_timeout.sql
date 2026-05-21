-- ADR-033 follow-up — per-function statement_timeout override.
--
-- Symptom (2026-05-21, prod ~8 700 cands): `loadCandidates` raised
-- `canceling statement due to statement timeout` even after the
-- CTE rewrite in 20260521000002. Diagnosis: the route
-- `/api/matching/run` authenticates with the user's JWT cookie, so
-- the Supabase client connects as the `authenticated` role. By
-- default Supabase pins `authenticated.statement_timeout = 8s`,
-- which is too tight for an aggregation over the full candidate
-- pool — no amount of plan-tuning fits.
--
-- Fix: attach a per-function `SET statement_timeout = '60s'` to
-- both matching RPCs. When the function is called, Postgres applies
-- the override as `SET LOCAL` for the function's scope only, and
-- restores the caller's timeout on return. This:
--   - keeps the function `security invoker` (RLS still applies),
--   - does NOT widen the timeout for the `authenticated` role
--     globally (other queries from the same role keep the 8s cap),
--   - is bounded to these two function names — easy to revert if
--     the underlying issue is fixed via a different vector
--     (move to async, raise role timeout, etc.).
--
-- Why 60s: matches `service_role`'s default cap. We never want a
-- matching call to run longer than that — H12 on Heroku is 30s
-- anyway, and the orchestrator's own diagnostics will surface
-- runs that approach the ceiling.

alter function public.match_pre_filter(jsonb, uuid)
  set statement_timeout = '60s';

alter function public.match_load_aggregates(uuid[], uuid)
  set statement_timeout = '60s';
