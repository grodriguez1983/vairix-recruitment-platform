# 📍 Status — Recruitment Data Platform

> Actualizado al final de **cada sesión** de Claude Code. Snapshot
> del estado; no es un registro histórico completo (para eso está
> el git log).

**Última actualización**: 2026-04-27
**Última sesión**: 2026-04-27 — **Bloque 19: UI exposure de `last_used` en results table (ADR-026 follow-up)**. Owner pidió mostrar "hace cuánto que no trabaja en esa tecnología" en la tabla de breakdown del matching para que la columna `years` post-decay no se lea como bug ("React 0.4y" sin contexto de cuándo fue el último uso). **Implementación**: nuevo módulo `src/lib/shared/format-time-ago.ts` — helper puro `formatTimeAgo(iso, now)` con cálculo calendario (year/month diff con UTC components, no aritmética de días promedio que rompía "exactly 1 year ago" → "11mo ago" por leap-year drift). Granularidad: `null|''|unparseable → '—'`, `same day | future → 'now'` (clamp), `0 calendar months → '<1mo ago'`, `< 12 → 'Nmo ago'`, `>= 12 → 'Ny ago'` (floor). 11 tests adversariales en `format-time-ago.test.ts` cubren null/empty/unparseable, future clamp, exactly-1-year, 6mo exacto, partial month floor, día <1mo, caso canónico ADR-026 (`2010-12-31` → `'15y ago'`), floor vs round. **TDD estricto**: RED `842b89f` con stub que typechecks pero falla por assertion (escape `TDD_RED=1`), GREEN `6f1a180` con la implementación calendario. **Wire** commit `915f9b0`: `results-table.tsx` agrega columna `LAST USED` entre `YEARS` y `RATIO`, `now = new Date()` hosteado una vez por panel render (single anchor cross-row, no per-cell drift). UI helper, no scoring — `new Date()` es OK acá; el matching sigue determinístico vía `catalogSnapshotAt`. Suite: 708/708 unit verde, typecheck + lint limpios. **Sin schema change, sin cambios al API HTTP** — los datos ya estaban persistidos en `match_runs.results[].breakdown_json` desde Bloque 18, este bloque solo expone. **Tech debt anotado**: la columna `years` ahora muestra `effective_years` post-decay con el mismo nombre que antes mostraba raw years; los reclutadores que usen runs históricos pre-Bloque-18 verán raw, post-Bloque-18 ven effective — sin migration ni badge visual. Tooltip explicativo "raw: X · decay: ×Y" quedó como follow-up.
**Última sesión previa**: 2026-04-27 — **Bloque 18: ADR-026 recency decay en cálculo de años por skill (half-life=4)**. Owner reportó un caso de dominio: dev con 5 años de Java entre 2005-2010 y 0 años desde entonces (15 años de gap) cobraba `years_ratio = 1` bajo baseline senior=3 (ADR-022) — el scorer colapsaba dos señales distintas ("cuánto trabajó con X" vs "cuán vigente está") en un solo número. **Decisión** (ADR-026): factor multiplicativo de recencia exponencial sobre el output de `yearsForSkill`, con half-life uniforme de 4 años y `asOf` REQUIRED en la API (no wallclock fallback — determinismo es contrato). `effective_years = raw_years × 0.5^(yearsSinceLastUse / HALF_LIFE_YEARS)`. `lastUsed = MAX(end_date ?? asOf)` sobre `kind ∈ {work, side_project}` mencionando la skill resuelta (education excluida, consistente con ADR-015/020). Para el caso del owner: 5 raw → ~0.36 effective → `ratio = min(0.36/3, 1) ≈ 0.12`. **Implementación**: nuevo módulo `src/lib/matching/recency-decay.ts` (3 funciones puras: `decayFactor`, `lastUsedFor`, `effectiveYearsForSkill`); `RequirementBreakdown` gana `raw_years`, `last_used` (ISO `YYYY-MM-DD`), `decay_factor` para auditoría en el `breakdown_json` persistido — `candidate_years` mantiene su nombre y carga `effective_years` (lo que feed el ratio). **Gates intencionalmente NO afectados**: el `roleGateFailed` (ADR-023 axis gate) sigue usando `yearsForSkill > 0` raw — comentado: bolting decay al gate doble-penalizaría candidatos que el ratio ya está justamente bajando. El `mustHaveGateFailed` evalúa `years_ratio > 0` que mecánicamente es `effective > 0`; como `decayFactor > 0` siempre para raw finitos, el gate es inafectado en comportamiento — solo cambia cuánto contribuyen al score. `totalWorkYears`/`candidateSeniorityBucket` (delta de seniority match) tampoco aplica decay — es seniority de carrera total, no skill-specific. **Procedimiento**: ADR primero (commit `5fbfc17`), luego TDD estricto: RED commit `047068d` con 18/20 tests fallando por assertion sobre stub que typecheckea (escape `TDD_RED=1` documentado por el hook), GREEN commit `9638fd3` con la implementación real (20/20 verde, reusa `parseDate` y `yearsForSkill` — el decay es envoltorio, no reimplementación). Refactor del aggregator commit `219b22a`: types updated, score-aggregator wired, 6 tests nuevos en describe ADR-026 (exposición de breakdown components, caso canónico del owner, regresión must-have gate, regresión role-essentials gate, inversión de ranking recent vs stale con mismas raw*years, neutral metadata para skill_id=null). Test legacy `test_single_skill_single_experience_exact_match` cambia a `end=null` (ongoing) para mantener intención sin conflar decay. UC-11 gana acceptance criterion `test_matcher_decays_stale_experience`. **Sin schema change** — todo cabe en `breakdown_json` jsonb. **Sin cambios al prompt de decomposition ni a la API HTTP**. Suite: **697/697 unit tests verde**, integration matching pass (2 tests, ~4.5s), typecheck + lint limpios. **Tech debt anotado**: (a) `HALF_LIFE_YEARS = 4` es heurística sin calibración con ground truth (ADR-026 §Negativas); ajuste futuro requeriría match_runs etiquetados con outcomes. (b) Decay uniforme — COBOL y React decaen al mismo ritmo; ADR futuro puede introducir override por skill (`skills.decay_half_life_years nullable`) cuando haya evidencia. **Pendiente manual** (decisión del owner): re-ejecutar matching contra JDs senior reales en dev y validar que candidatos con experiencia legacy mayoritaria caen del top como se espera; comparar contra el ranking previo persistido en `match_runs` (los rankings históricos quedan como snapshots inmutables — re-correr produce el orden nuevo).
**Última sesión previa**: 2026-04-24 — **Bloque 17: fix `URI too long` en extract-cvs listPending (segunda aparición)**. Misma clase que Bloque 16 pero en otro path: tras el fix de embeddings, el owner siguió el pipeline (`parse:cvs → extract:cvs → embed:all`) y `extract:cvs --batch=200` explotó con `URI too long`. Root cause: `src/scripts/extract-cvs.ts:89` (y su gemelo duplicado en `tests/integration/cv/extraction-worker.test.ts:74`) armaba el set de files ya extraídos como `q.not('id', 'in', \`(${excluded.join(',')})\`)`inline, y con 244`candidate_extractions`pre-existentes la URL se pasaba del budget PostgREST. **Fix** (TDD RED→GREEN, scope=cv): nuevo módulo`src/lib/cv/extraction/list-pending.ts`con`listPendingExtractions(db, {model, promptVersion, limit})`que (a) carga el excluded set en memoria, (b) pide`limit + excluded.size`rows a`files`sin ningún`NOT IN`en la URL, (c) filtra client-side y devuelve las primeras`limit`. 5 tests adversariales en `list-pending.test.ts`con un`FakeDb`que loggea filter calls: nunca se llama`.not('id'|'file_id', 'in', ...)`sin importar el tamaño del excluded (regresión), el limit se respeta,`limit + excluded.size`se pide al server (evita falso-vacío si los primeros N están excluidos todos), empty pending → [], scope por (model, prompt_version). El CLI y el integration test ahora comparten el helper — desduplicación del closure buggy. Commits`7582b7e`(RED, 5 tests rojos + stub que tira) y`e440226`(GREEN, impl + 3 files replaced + integration test verde contra supabase-test). **Verificación runtime** post-fix contra dev DB:`pnpm extract:cvs --batch=200`→`processed=192 extracted=173 skipped=6 errored=13 experiences=1250 skills=3187`. `candidate_extractions`subió de 244 → **414**,`files_parsed`263 → **438** (los 176 pendientes se habían drenado con`pnpm parse:cvs`previa a la re-corrida de extract). Los 13 errored son LLM/shape failures, quedan sin`candidate_extractions`row y la próxima corrida los reintenta. **Tech debt que arrastra de Bloque 16**: (a) sync_state.last_cursor nunca persistido, (b) sync:full/sync:backfill declarados sin archivos, (c)`loadCandidatesPage`latente. **Bloque 16 previo (misma sesión)**: fix`URI too long`en embeddings workers + partial backfill 200→~400 candidates. El owner quiso traer otros 200 candidates desde Teamtailor para llegar a ~400 totales. El mecanismo documentado en`sync-incremental.ts`es`SYNC_MAX_RECORDS=<cap>`como hard cap por run. **Hallazgo colateral**:`runIncremental`(src/lib/sync/run.ts:187) nunca persiste`last_cursor`en`releaseLock` aunque el contrato de la interfaz lo expone (`releaseLock.ReleaseOutcome.lastCursor`), así que el "watermark" del syncer de candidates queda siempre en `null`y cada corrida arranca desde el inicio de TT. Consecuencia operativa: subir el cap a 400 es equivalente a re-traer los 200 previos (idempotente via upsert) + los 200 nuevos. **Operación**:`SYNC_MAX_RECORDS=400 pnpm sync:incremental candidates && pnpm sync:incremental {stages,users,jobs,custom-fields} && SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental {applications,notes,evaluations,files}`. Total local 203 → 403 candidates (la diferencia +3 ya estaba del run previo, no repetido). **Bug de embeddings**: al correr `pnpm parse:cvs && pnpm extract:cvs && pnpm embed:all`, `parse:cvs`y`extract:cvs`trabajaron OK (batch=50 default, re-correr drena la cola) pero`embed:all`falló con`[embed] profile failed: failed to load candidate profile data: URI too long`. Root cause: `worker-runtime.runEmbeddingsWorker`pagina candidates en`batchSize=500`y cada worker hace`.in('id'|'candidate_id', [...candIds])`con la página entera — a 500 UUIDs son ~20 KB de value list, PostgREST/Node default URL budget es ~16 KB, se revienta pasando ~400 candidates (40 chars/UUID después de URL encoding). 8 call sites vulnerables:`worker-runtime.loadCandidatesPage`(el`.in()`del filtro opcional),`worker-runtime.loadExistingHashes`, `profile-worker.loadCandidateData`+`loadTagsByCandidate`, `notes-worker.loadNotesByCandidate`, `cv-worker.loadFilesByCandidate`, `evaluation-worker`(dos:`evaluations`y`evaluation_answers`). **Fix** (TDD RED→GREEN, scope=embeddings): nuevo helper `src/lib/shared/chunked-in.ts`exporta`runChunked(ids, chunkSize, fetch)`+`IN_QUERY_CHUNK_SIZE=100`(100 UUIDs ≈ 4 KB, safe margin). 12 tests adversariales en`chunked-in.test.ts`: empty input nunca llama fetch, boundary `ids.length === chunkSize`→ single call, 201 ids → [100,100,1], orden preservado cross-chunk, chunkSize ≤ 0 o no-integer rechazado, fetcher errors surface unwrapped, stop-on-first-failure, plus budget assertion estática`IN_QUERY_CHUNK_SIZE * 40 < 15000`. Commits: `4e0dbfd`(RED stub + 12 tests),`747cdaa`(GREEN: impl + aplicado a 7 de los 8 call sites — los 6 per-page +`evaluation_answers`; `loadCandidatesPage`queda con inline NOTE como follow-up porque interactúa con`.range()`y no es reachable desde el CLI`embed:all`). **Verificación runtime** post-fix contra dev DB (403 candidates): profile processed=403 regenerated=203 reused=200 (104s), notes processed=211 skipped=192 regenerated=92 reused=119, cv processed=244 skipped=159 regenerated=51 reused=193, evaluation processed=136 skipped=267 regenerated=62 reused=74 — idempotencia confirmada, los 200 viejos reusaron hash. **Tech debt anotado**: (a) `sync_state.last_cursor`nunca persistido — candidato a ADR; sin ese cursor, "incremental" es un misnomer: el syncer siempre arranca de la primera página de TT. Upsert idempotente cubre en runs chicos, pero es costo innecesario de red en backfill. (b)`package.json`declara`sync:full` (`src/scripts/sync-full.ts`) y `sync:backfill` (`src/scripts/backfill.ts`) que **no existen en el tree** — y `.github/workflows/backfill.yml:79-83`los invoca para`entity=all`; el workflow está roto. Solución mínima: implementar `sync:full`como orquestador de`sync:incremental`en orden`stages→users→jobs→custom-fields→candidates→applications→notes→evaluations→files`con`SYNC_SCOPE_BY_CANDIDATES=1`en los hijos. ADR candidato antes de implementar. (c)`worker-runtime.loadCandidatesPage`queda con`.in(candidateIds)`no chunked por la interacción con`.range()`; latente hasta que algún caller pase >100 ids al opcional filter. Inline NOTE marca el gap. (d) `extract:cvs`reportó`errored=7`sobre 50 procesados — no inspeccionado esta sesión; no son fatales (quedan persistidos, re-correr los saltea). **Bloque 15 previo (sesión 2026-04-23)**: ADR-025 default results view passed-only + JD/requirements panel. Tras validar ADR-024 (Bortoli #120 failed → #1 passed con match run`918c17e6-...`), el owner reportó que la tabla de `/matching/runs/:id` mezclaba passed+failed ordenados por rank, leyéndose como ruido en la shortlist. **Decisión** (ADR-025): default view de la page Y del API (`GET /api/matching/runs/:id/results`) filtran `must_have_gate='passed'`. Rows `failed`siguen persistidos en`match_results` para auditoría pero invisibles desde UI. El rescue bucket de ADR-016 cubre el caso ortogonal "skill solo en parsed*text"; gate-failed con resolución parcial pierden el breakdown diagnóstico en UI — tradeoff aceptado (toggle opt-in quedó como follow-up si emerge la necesidad). **Panel JD nuevo** arriba del listado (`job-query-panel.tsx`): muestra `raw_text`en`<details>`collapsible (guardado por`raw_text_retained`) y los requirements decompuestos como tags inline flow con OR-groups atómicos (ADR-021) + secciones separadas para `role_essentials`(ADR-023) y`unresolved_skills`. **Honestidad TDD**: la decisión se tomó verbal y se implementó primero (commits `7f10743`UI filtro+panel,`99388b3`fix layout inline). Luego, al preguntar el owner por la metodología, se agregó retroactivamente: ADR-025, test regression`route.filter.test.ts`(mock del supabase client + spy sobre`.eq()`, verified RED al sacar el filtro), entrada en status.md. **Práctica a revertir**: decisión estructural → ADR ANTES o DURANTE, no después. Commit bundle `docs(adr-025)`: ADR + test + status. **Bloque 14 previo (misma sesión)**: ADR-024 normalizer collapses `-`/`*` between alphanumerics. Root cause del caso Bortoli en el JD Senior Full-Stack Engineer (`36cb36bc-...`): su CV trae 3 años de React Native, pero el CV parser escribió `skill*raw="React-Native"`y el resolver de ADR-013 §2 solo preservaba mayúsculas/espacios, así que normalizaba a`react-native`y no matcheaba el slug`react native`ni ningún alias — el axis mobile fallaba y el gate conjuntivo de ADR-023 lo dejaba #120/failed pese a tener experiencia real. 50 rows en 25 candidatos estaban en la misma situación. **Decisión**: ADR-024 agrega un paso al pipeline:`([a-z0-9])[-\*](?=[a-z0-9])`→`$1 ` con lookahead para colapsar `a-b-c` en un solo pase sin consumir el anchor. Scope narrow: solo entre alfanuméricos; `node.js`, `c++`, `c#`, `ci/cd`, `-react` quedan intactos. Mirror SQL en `public.resolve_skill` usando AREs de Postgres (soportan lookahead). Migración `20260423190000*...` re-normaliza 3 aliases guardados con hyphens literales (`c-sharp`, `ci-cd`, `gitlab-ci`→ forma con espacio) y hace backfill idempotente de`experience_skills.skill_id`donde el resolver ahora resuelve (4 rows recuperadas en dev para Bortoli, 0 rows pendientes restantes según`resolve_skill`post-migración).`src/lib/skills/seed.ts`actualizado para que`applyCuratedSeed`en tests no reintroduzca los hyphens. 7 tests RED nuevos en`resolver.test.ts`(canonical case + underscore + multi-hyphen + leading/trailing + internal punct preservation + alias normalized + alphanum∣symbol edge). Equivalence test`resolver-equivalence.test.ts` ampliada a 47 inputs deterministas. Fixtures de 3 tests integración migradas de slugs hyphenated a espacio (`derive e2e typescript`, `f4008 e2e nodejs`, `decompose e2e nodejs`); los `skill_raw`siguen con hyphens para ejercitar la normalización end-to-end. Commits:`01a4975`(RED),`33c01a9`(GREEN TS+SQL+migración+seed+tests+types regen). 936/936 suite verde, typecheck + lint limpios. **Pendiente manual**: re-ejecutar`/api/matching/run`contra`36cb36bc-...`con cookie admin para confirmar que Bortoli sube del rank #120 failed a un rank activo con el axis mobile cubierto. **Bloque 13 previo (misma sesión)**: ADR-022 seniority-derived`min_years`baseline. Durante la validación manual del fix del bloque 12 (paginación db-deps) contra el JD`2d4d6faa-4793-4b04-b581-e9819726f1b9`"Senior Frontend", el owner reportó ranking invertido: Lucas Pereira (4 meses React) ranked #1 score 48.75, Hernán Garzón (7.48 años React) ranked #5 score 37.50. Root cause: con prompt v5 el decomposer es correctamente conservador y emite casi todo`min_years: null`— la rama binaria`ratio = years > 0 ? 1 : 0`colapsa 4m y 7.48y a la misma contribución, y la señal`seniority: senior`del JD solo aporta ±5 al total (nunca baja a cada per-skill). **Decisión**: ADR-022 agrega`seniority-defaults.ts`con baselines canónicos (junior=1, semi_senior=2, senior=3, lead=5, unspecified=null-keep-binary). En score-aggregator:`effectiveMinYears = req.min_years ?? seniorityBaseline`— explicit siempre gana;`unspecified`preserva la rama binaria. 6 tests nuevos RED→GREEN cubriendo bucket-por-bucket + regresión explicit min_years + regresión unspecified + escenario hero Lucas-vs-Hernán. Commits:`0609658`(RED),`a2fbd96`(GREEN),`230c30a`(ADR). **Bloque 12 previo (misma sesión)**: **db-deps paginación past PostgREST max_rows=1000**. Incidente 2026-04-23:`job_query 2d4d6faa-...`corrió con 203 candidatos evaluados pero 53 con`total_score=0`(ej. Elena Tibekina rank 153). Root cause:`supabase/config.toml`tiene`max_rows=1000`como hard cap de todo`SELECT`sin paginar, y`db-deps.loadExperiences/loadLanguages/fetchAllCandidateIds/fetchCandidateMustHaveCoverage`hacían un single`.select(...).in(...)`sin`.range(...)`loop — tail silenciosamente truncado. Fix:`PAGE_SIZE=500`(< max_rows para EOF signal confiable) +`IN_CHUNK_SIZE=200`(evita "URI too long" al chunkear el arg de`.in`) + helper `paginateRange<T>(label, runPage)`con MAX_ITERATIONS=10000 safety. RED test seedéa 1_100 candidatos con 1 experience cada uno → asserts`loadCandidates`devuelve las 1_100 experiences y`preFilter`devuelve los 1_100 candidate_ids. Commits:`54153fb`(RED),`88a1942`(GREEN). **Bloque 11 previo**: ADR-021 OR-groups en decomposition. Root cause del false-negative repetido de Elena Tibekina / Juan Jose Diaz / Victor Abeledo en el JD "React+TS + (Tailwind o styled-components)": el schema de`Requirement`era plano sin noción de alternativas, así que Tailwind + styled-components se emitían como dos must-have singletons ANDeados — los 3 candidatos tenían styled-components pero no Tailwind, y el pre-filter los eliminaba antes del ranker. **Decisión**: ADR-021 introduce`alternative_group_id: string | null`como campo plano en cada`Requirement` (null = singleton, non-null shared = OR group; AND entre grupos, OR dentro). Se eligió contra una alternativa nested (`alternatives: Requirement[]`) porque preserva la shape del JSON schema strict de OpenAI (`additionalProperties: false`+`required`) sin recursión. **Cambios** (10 commits RED/GREEN, en orden): (a) `types.ts`+`RequirementSchema`extendidos con`alternative_group_id: z.string().min(1).nullable()` (`35954fe`→`f20c4b2`); (b) `decompose-v1.ts`prompt bumped`2026-04-v4`→`2026-04-v5`con regla 10 nueva (null singletons, same-id OR, conjunción "A y B" NO es group), ejemplos CORRECT/WRONG, y retrofit de los ejemplos de Tailwind/Jest con ids`g-css`/`g-testing` (`5137f6a`→`60087ab`); (c) `openai-decomposer.ts`agrega el campo como required + nullable en el`response_format.json_schema`; (d) `pre-filter.ts`refactor:`buildMustHaveGroups(jobQuery)`split por`alternative_group_id`(singletons sintéticos para null), candidato`included`iff cubre ≥1 resolved alt de cada grupo activo,`missing_must_have_skill_ids` es la flat-union de alternativas en grupos fallados (`28cc761`→`4429b3a`); (e) `score-aggregator.ts`refactor: bucketea breakdown por group_id, **gate falla iff todos los resolved de un grupo tienen`years_ratio=0`** (fully-unresolved group no falla — ADR-015 §Consecuencias sigue), **score usa `totalWeight += groupWeight`(una sola vez por grupo) y`totalContribution += max(contribution across alternatives)`** para mantener el denominador idéntico a un singleton y no castigar OR-groups (`455b5e0`→`89fdbb0`); (f) `run-match-job.ts` `collectFailedCandidates`bucketea por group_id y solo emite skill_ids de buckets no satisfechos (evita que Apollo Client partial en un`g-gql` satisfied arrastre al rescue bucket) (`0be655d`→`7377ddb`). 29 fixtures de test actualizadas via Node script para agregar `alternative_group_id: null`a cada literal de`Requirement`/`ResolvedRequirement`(10 archivos). **Suite**: 617/617 unit tests verdes, typecheck limpio, lint limpio. Integración matching+rag pasa (decompose cache cycle + ranker e2e). **Validación end-to-end manual**: deferida — el cookie JWT admin en`playwright/.auth/admin.json`está expirado y regenerarlo requiere`pnpm test:db:start`+ global-setup; el pipeline queda cubierto por la suite de integración (13 tests) hasta que se quiera una demo contra dev DB real. **Bloque 10 previo (misma sesión)**: side_project weighted-years (ADR-020). Durante la demo manual contra los 200 candidatos, Graciela Benbassat (psicóloga con bootcamp Backend 2022-2023 como`kind='side_project'`) aparecía `FAILED, score=0.0`. Root cause: inconsistencia entre `pre-filter.ts`(acepta cualquier`experience_skills`sin filtrar`kind`) y `years-calculator.ts`+`score-aggregator.ts`(solo contaban`kind='work'`, ADR-015 §1). Candidato con toda su exposición a la skill como `side_project`pasaba el prefilter pero fallaba el must-have gate con`years_ratio=0`. **Decisión**: ADR-020 ajusta el invariant — `yearsForSkill = workYears + 0.25 × sideProjectNetYears`donde`sideProjectNetYears`usa`subtractIntervals`sobre los intervalos de work para no double-contar ventanas ya cubiertas.`education`sigue excluido. Weight 0.25 elegido para desbloquear el gate pero subordinar el ranking (6m bootcamp ≈ 1.5m "work-equivalente"). Commits`f27b7f3`(RED: 3 tests nuevos rojos + rename de`test_side_project_excluded_from_years`→`test_side_project_contributes_at_quarter_weight`), `9d070e3`(GREEN:`subtractIntervals(a,b)`en`date-intervals.ts`; `yearsForSkill`reescrita con`collectIntervals(kind)`+ merge por kind + set-subtraction; prompt-version test bumped a`2026-04-v3`para alinear con el fix de hallucinated*snippet del bloque 9). ADR-015 marca §1 como "supersedido parcialmente por ADR-020" con nota inline. Suite completa: **882/882 tests verde, 51s**. **Pendiente manual**: re-correr matching en dev contra el mismo job_query para confirmar que Graciela pasa de`FAILED`a un score bajo pero > 0. **Bloque 9 previo (misma sesión)**: **test isolation + decomposer skill_raw fix**. (a) **Prompt decomposer v2** — ADR-014 prompt bump`2026-04-v1`→`2026-04-v2`con regla nueva "skill*raw MUST be short canonical name, not full sentence" (sin esa regla el LLM copiaba "5+ años construyendo features en Ruby on Rails" a skill_raw, el catalog resolver de ADR-013 §2 no matcheaba nada, y el match scorer degeneraba a 0.0). Version bump invalida content_hash de`job_queries`naturally. Test en`decompose-v1.test.ts`guarda la regla (skill_raw + "short canonical" + "not a sentence"). 879 tests verde contra la suite completa. (b) **Test DB isolation (ADR-019)** — root-cause fix al incidente 2026-04-22 donde`pnpm vitest run`destruyó data productiva local (200 candidatos / 195 resumes / ~580 embeddings) vía cleanup CASCADE. Segunda instancia de Supabase:`supabase-test/supabase/config.toml`con project_id`recruitment-platform-test`+ port block +10000 (64321/64322). Migraciones single-sourced via symlink`supabase-test/supabase/migrations → ../../supabase/migrations`. `.env.test`redirige`SUPABASE_TEST**`+`NEXT\*PUBLIC_SUPABASE_URL`+`SUPABASE_SECRET_KEY`al 64321.`tests/setup/load-test-env.ts`(parser dotenv nativo, sin dep nueva) cargado via`setupFiles`en`vitest.config.ts`. `pnpm test:db:{start,stop,reset,status}`en package.json. 133/133 RLS tests pass contra test-db, dev DB verificada untouched post-run. **Tech debt anotado** (skipping TDD): el parser de`load-test-env.ts`tiene lógica no trivial (precedencia shell-gana, comments, blanks, archivo faltante) y fue escrito sin RED tests previos — agregar suite unitaria cuando se tenga aire. También se omitieron: lectura previa de`docs/test-architecture.md`, split en commits atómicos (todo quedó stageable en 4-5 commits), entrada en Chronicle de la sesión. (c) **Bug previo de PostgREST this-binding** en `candidate-resumes.ts`+`candidates.ts` committed en sesión previa (`1cff526` feat matching/decompose + commits anteriores). **Siguiente**: re-cargar 200 candidatos en dev (ETL + resumes + parse + extract + embed) para demo urgente.
**Última sesión previa**: 2026-04-21 — **Bloque 7: cierre de pendientes post-F4-009** (`51c6295`, `1285c4c`→`13aa0a0`, `aaeb9de`→`82d0538`). `fix(matching): resolve skills table name + smoke selector drift`corrige dos bugs descubiertos durante Block 6: (a)`skills_catalog`→`skills`en`db-deps.ts:206`y`app/api/matching/runs/[id]/evidence/route.ts:82`(el catálogo vive en`skills`, ADR-013; el nombre viejo nunca existió), (b) `smoke.spec.ts:34`Playwright strict mode violation —`getByLabel('Status')`matchea dos selects porque el`<label>`envuelve todo y el accessible name concatena option text; fix con`page.locator('label', {hasText:/^Status/}).locator('select')`. **F4-008 ter cerrado** (gap "rescue vs pre-filter" de ADR-016 §"Gap conocido"): `preFilterByMustHave`ahora retorna`{included, excluded: PreFilterExcludedCandidate[]}`con`missing_must_have_skill_ids`por candidato;`fetchCandidateMustHaveCoverage(skillIds)`reemplaza la query de intersección con una por-candidate-coverage (más barata en F1 que una RPC dedicada);`runMatchJob`hace`mergeRescueInputs(gateFailed, excluded)`antes de invocar`rescueFailedCandidates`(la firma del hook no cambia, blast radius mínimo). Unit coverage: 9 tests en`pre-filter.test.ts`+ 2 nuevos en`run-match-job.test.ts` (merge con gate-failed y excluded-solo). ADR-016 addendum documenta el cierre. **Bloques previos de la misma fecha**: **Block 4 (uncataloged admin surface ADR-013 §5) + Block 5 (/admin/skills CRUD ADR-013 §6) + Block 6 (smoke E2E UC-11) cerrados**. Block 4 (`a3b45c9`→`693cd3b`→`0bc535a`): `aggregateUncataloged`puro con TDD RED→GREEN (6 tests, agrupa por forma normalizada case/whitespace-insensitive, excluye blacklist, ≤3 samples en first-seen order, sort count desc → alias asc),`listUncataloged(db)`con FETCH_CAP=5000,`addSkillToCatalog` que valida slug (`/^[a-z0-9][a-z0-9+#./-]*[a-z0-9+#/]$|^[a-z0-9]$/`) + pre-flights conflicts + inserta skill + aliases `source='admin'`+ reconcilia experience_skills,`blacklistAlias`idempotente (swallow 23505). Server actions con`requireRole('admin')`+`revalidatePath`. Página server-rendered `/admin/skills/uncataloged`+ client`uncataloged-row.tsx`con`useTransition`, form inline (canonical + slug + category opcional) + botón blacklist. Block 5 (`1acea1a`): `src/lib/skills/admin-service.ts`con`listSkills({search, includeDeprecated, limit, offset})`(or.ilike slug + canonical_name + nested`skill_aliases(id)`para counts),`getSkill`con usage_count desde`experience_skills`, `updateSkill`(canonical_name + category editables, slug immutable),`setDeprecated`soft-delete,`addAlias`idempotente con conflict error +`removeAlias`. Server actions + páginas `/admin/skills`(list con search + deprecated toggle + paginación) y`/admin/skills/[id]`(editor client con aliases por source). Landing`/admin` extendido con 2 cards (uncataloged con count badge + catalog). Block 6 (`6806323`): Playwright smoke `tests/e2e/matching-smoke.spec.ts`— 6 tests (/matching/new form, /matching/runs/:id Alice rank 1 score 100, drawer expand con React cell + evidencia panel, /admin/skills lista seeded e2e-react, /admin/skills/uncataloged surfaces seeded zig alias, /admin landing links).`seed.ts`extendido: skill e2e-react + Alice con file (parsed_text React+Zig) + extraction + 1 experience + 2 experience_skills (react resolved + zig uncataloged) + job_queries con resolved_json/decomposed_json + match_run completed + match_results rank=1 score=100 breakdown_json con React requirement.`global-setup.ts`escribe`playwright/.auth/e2e-ids.json`. 6/6 pass contra local Supabase. **Drift pre-existente observado** (fuera de scope F4-009): `smoke.spec.ts:34 "status filter narrows"`falla con strict mode en`getByLabel('Status')` (ahora matchea también el Job select). **Bloques previos de la misma fecha**: Block 1 (languages persistence) + Block 2 (F4-008 bis match_rescues + FTS fallback) + Block 3 (F4-009 UI) documentados abajo. Block 1 (`ec53ed6`): `deriveLanguages`cableado en el worker de extracción +`candidate_languages`persistidas +`db-deps.loadLanguages` contra tabla real; 14 worker tests. Block 2 (`6921fe0`→`54825c4`): migraciones `20260421000004_match_rescues.sql`(tabla insert-only via trigger + PK compuesta),`20260421000005_rls_match_rescues.sql`(own-run-or-admin SELECT/INSERT paridad ADR-017; admin-only DELETE),`20260421000006_match_rescue_fts_search.sql`(RPC`security invoker`con ts_rank + ts_headline sobre`files.parsed_text`); servicio puro `src/lib/rag/complementary-signals.ts`con`FTS_RESCUE_THRESHOLD=0.1`+`EVIDENCE_SNIPPET_LIMIT=5`(9 tests); orchestrator`runMatchJob`extendido con`rescueFailedCandidates?`hook que swallowea errores (ADR-016: bucket ortogonal al ranking);`db-deps.rescueFailedCandidates`resuelve skill_id→slug via`skills_catalog`, invoca RPC, persiste en `match_rescues`; GET `/api/matching/runs/:id/rescues`bajo RLS. **Gap conocido** documentado en ADR-016 §"Gap conocido": el pre-filter actual excluye candidatos por catálogo antes del ranker, así que el bucket solo captura gate-failed con must-have parcial (no el caso canónico de "skill solo en parsed_text"); fix postergado a F4-008 ter. Block 3 (esta commit): 3 páginas server-rendered + 1 client form —`/matching/new`(paste JD → decompose → resolved panel con must/years/resolved badges + unresolved list → botón "run match" → redirect),`/matching/runs/:id`(metadata + results table con gate badge + score + drawer expandible con breakdown por skill e evidencia por experience),`/matching/runs/:id/rescues`(bucket FTS con highlighting`«`→`<mark>`). Sidebar extendido con enlace "Matching". RLS hace ownership; fetch de candidate names vía hydrate in-line. 564 unit + 148 integration tests verdes. ADR-017 + migración `20260421000001_rls_match_results_insert_own_run.sql`desbloquean la persistencia de`match_results` por el recruiter dueño del run. Integration e2e (`tests/integration/matching/run-match-job.test.ts`) seedéa 20 candidates (5 strong / 10 medium / 5 missing must-have) → decompose stub → runMatchJob → asserts run completado + 15 match_results persistidos (5 excluidos por pre-filter), ranks 1..15 contiguos, scores monotónicos, top-5 = strong set, breakdown_json round-trip. **F4-006, F4-007 bis y F4-007 cerrados**. F4-006 sub-A..sub-D: DecompositionProvider (StubDecompositionProvider + OpenAIDecompositionProvider con prompt-v1), content_hash SHA-256 sobre (normalized_text ∥ model ∥ promptVersion) con NUL separator, `decomposeJobQuery(raw_text, deps)`idempotente por hash + resolución de catálogo + persist en`job_queries`+ API route POST`/api/matching/decompose`con Zod schema +`requireAuth()`. F4-007 bis: migración `20260420000009_candidate_experiences_description_tsv.sql`+ GIN index + integration test (match/miss/null). F4-007 sub-A..sub-D matching ranker:`date-intervals.ts`(MS_PER_YEAR, Interval, toInterval, overlapRatio) compartido;`variant-merger.ts`(284 LOC, COMPANY_SUFFIX_RE, titleCompatible lenient con substring + Jaccard ≥ 0.5, greedy best-match, near-miss diagnostics);`years-calculator.ts`sweep-line;`score-aggregator.ts`con must-have gate (resolved + ratio=0 → failed; unresolved skill_id NO falla gate — ADR-015 §Consecuencias), weights 2.0/1.0 normalizados, language bonus ±5/-10, seniority bucket (<2 junior, 2-5 semi, 5-10 senior, 10+ lead) ±5, clamp [0,100];`ranker.ts`DeterministicRanker orquestador con sort (score desc, candidate_id asc), catalogSnapshotAt wired como now. 47 matching + 3 F4-007bis = 777 tests verde. Siguiente: F4-008 (API`/api/matching/run` + persistencia match_runs/match_results) y F4-008 bis (match_rescues + fallback FTS ADR-016).
**Fase activa**: \*\*Fase 4 — Inteligencia\*\* (eje matching). F1 fundación + F2/F3 slices previas siguen done.

---

## ✅ Completado

- **ADR-025 — default results view is passed-only + JD/requirements panel** ✅
  done — 2026-04-23 — Bloque 15. Commits `7f10743` (feat UI filtro +
  JobQueryPanel), `99388b3` (fix tag layout inline wrap), +
  `docs(adr-025)` bundle (ADR + `route.filter.test.ts` regression +
  status). `/matching/runs/:id` y `GET /api/matching/runs/:id/results`
  filtran `must_have_gate='passed'`; failed rows quedan en DB para
  auditoría. Panel nuevo arriba del listado: raw JD collapsible +
  requirements como tags con OR-group atómico + role_essentials +
  unresolved. Test pin-ea el invariante via mock del supabase client
  (RED probado al removerlo). Honestidad TDD: la ADR se hizo
  retroactiva tras pregunta del owner por la metodología — anotado
  en la sesión como anti-pattern a revertir.

- **ADR-024 — normalizer collapses `-`/`_` between alphanumerics** ✅
  done — 2026-04-23 — Bloque 14. Commits `01a4975` (RED 7 tests en
  `resolver.test.ts`), `33c01a9` (GREEN TS pipeline + SQL mirror +
  migración re-normaliza 3 aliases y backfillea `experience_skills`
  - `seed.ts` alineado + types regen). Pipeline suma un paso
    `([a-z0-9])[-_](?=[a-z0-9])` → `$1 ` con lookahead para colapsar
    `a-b-c` en un pase; scope narrow preserva `node.js`, `c++`, `c#`,
    `ci/cd`. Resuelve el caso canónico Bortoli (React-Native en CV →
    resolver missed → mobile axis gate=fail en el JD Senior Full-Stack
    `36cb36bc-...`). 50 rows / 25 candidatos afectados en dev — 4
    recuperadas para Bortoli, `count(*) filter (where skill_id is null
and resolve_skill(skill_raw) is not null) = 0` post-backfill. 3
    integration test fixtures migradas de slugs hyphenated a forma con
    espacio. 936/936 tests verde. **Pendiente manual**: regenerar cookie
    admin y re-correr match sobre `36cb36bc-...` para validar que
    Bortoli sube de #120 failed a un rank activo.

- **ADR-022 — baseline `min_years` derivado de seniority** ✅ done —
  2026-04-23 — Bloque 13. Commits `0609658` (RED 6 tests),
  `a2fbd96` (GREEN `seniority-defaults.ts` + `score-aggregator.ts`),
  `230c30a` (ADR). Fix al ranking invertido observado contra
  `job_query 2d4d6faa-...`: con `min_years: null` (caso típico post
  prompt v5) y JD senior, 4 meses y 7.48 años daban la misma
  contribución binaria; ahora el baseline canónico de la seniority
  (1/2/3/5 para junior/semi/senior/lead) opera como piso implícito
  cuando el requirement no trae `min_years` explícito. `unspecified`
  preserva la rama binaria. 623/623 unit tests verdes. **Pendiente
  manual**: regenerar cookie admin y re-ejecutar el match sobre
  `2d4d6faa-...` para validar end-to-end que Hernán sube sobre Lucas.

- **db-deps paginación past PostgREST max_rows** ✅ done — 2026-04-23
  — Bloque 12. Commits `54153fb` (RED integration con 1_100
  candidatos seedeados), `88a1942` (GREEN `paginateRange` helper +
  `IN_CHUNK_SIZE=200` chunking + `PAGE_SIZE=500` range loop en
  `loadExperiences`/`loadLanguages`/`fetchAllCandidateIds`/
  `fetchCandidateMustHaveCoverage`). Cierra el bug silencioso donde
  `supabase/config.toml max_rows=1000` descartaba la tail de
  `.select(...).in(bigList)` sin paginar → 53/203 candidatos con
  `total_score=0` en `job_query 2d4d6faa-...`.

- **ADR-021 — `alternative_group_id` en `Requirement` (OR groups)** ✅
  done — 2026-04-23 — Bloque 11. Commits `35954fe`→`f20c4b2`
  (schema+types), `5137f6a`→`60087ab` (prompt v5), `28cc761`→`4429b3a`
  (pre-filter), `455b5e0`→`89fdbb0` (score-aggregator), `0be655d`→`7377ddb`
  (rescue). Campo plano `alternative_group_id: string | null` en cada
  `Requirement`; null = singleton, same-id = OR (AND entre grupos, OR
  dentro). Pre-filter agrupa must-haves y pide cobertura ≥1 por grupo;
  score-aggregator colapsa alternativas a un max por grupo con peso
  único (evita undernormalizar OR-groups contra singletons); rescue
  pipeline emite skill_ids solo de grupos no satisfechos. 617/617 unit
  tests verdes. **Pendiente manual**: regenerar cookie admin y correr
  el JD "React+TS + (Tailwind o styled-components)" end-to-end para
  confirmar que Elena Tibekina / Juan Jose Diaz / Victor Abeledo
  surgen — validación cubierta indirectamente por los 13 integration
  tests del pipeline matching+rag.

- **ADR-018 — `candidates.attributes.resume` como segunda fuente de CVs** ✅
  done — 2026-04-21 — Bloque 8. Commits `54716c0` (migración
  `files.source`), `b8cd734` (RED candidate-resumes), `1eeaa53` (GREEN
  downloader), `04089b4` (RED factory), `7146c6e` (GREEN factory),
  `d9b0814` (CLI wiring). Descubrimiento: el ETL solo consumía
  `/v1/uploads`, ignorando `candidates.attributes.resume` (URL firmada
  de S3 de ~60s con PDF generado por TT). Smoke test mostró 18/200
  candidates con CV (~9%); la mayoría de sourced candidates pasaban
  invisibles al parser. Fix: migración agrega
  `files.source text not null default 'uploads' check (source in
('uploads', 'candidate_resume'))`; nuevo módulo
  `src/lib/sync/candidate-resumes.ts` namespace-a `files.teamtailor_id`
  como `resume:<candidate_tt_id>` para evitar colisiones con el dominio
  numérico de uploads; `candidatesSyncer` pasa a factory
  (`makeCandidatesSyncer({ downloadResumesForRows })`) — el hook corre
  post-upsert candidates y swallowea errores para no matar el batch;
  `candidate-custom-fields.ts` extraído de `candidates.ts` para
  mantenerlo bajo 300 LOC (CLAUDE.md §📏). 11 unit tests nuevos en
  `candidate-resumes.test.ts` + 6 nuevos en `candidates.test.ts`
  (mapResource resume_url, factory binding, hook invocation, swallow
  failures). Tests totales: 608 unit verdes. **Pendiente**: re-sync de
  los 200 candidatos ya presentes (`update sync_state set
last_synced_at = null where entity = 'candidates';` + rerun) para
  traer sus resumes ahora que el pipeline los ve.

- **F4-008 ter — rescue vs pre-filter gap** ✅ done — 2026-04-21 —
  Bloque 7. Commits `1285c4c` (RED pre-filter), `13aa0a0` (GREEN
  pre-filter), `aaeb9de` (RED orchestrator merge), `82d0538` (GREEN
  orchestrator merge). Cierra el gap documentado en ADR-016 §"Gap
  conocido":
  - `preFilterByMustHave` firma nueva:
    `{included: string[], excluded: PreFilterExcludedCandidate[]}`
    donde `PreFilterExcludedCandidate = {candidate_id,
missing_must_have_skill_ids}`. El complemento contra la coverage
    parcial se deriva en la función pura (sin I/O extra).
  - `db-deps.fetchCandidateMustHaveCoverage(skillIds)` reemplaza la
    query de intersección: devuelve pares
    `(candidate_id, covered_skill_ids)` contra `experience_skills +
candidate_experiences!inner`; el cálculo included/excluded queda
    en JS (para F1 ~100 candidatos × N must-haves es más barato que
    una RPC dedicada).
  - `runMatchJob.mergeRescueInputs(gateFailed, excluded)` dedup por
    candidate_id (los dos sets son disjuntos por construcción, pero
    se defiende igual) + forwards al hook `rescueFailedCandidates`
    sin cambios de firma. El bucket `match_rescues` ahora cubre el
    caso canónico "skill sólo en `files.parsed_text`".
  - Unit coverage: 9 tests en `pre-filter.test.ts` (incluye zero
    coverage_rows defensivo + tenant_id propagation) + 2 nuevos en
    `run-match-job.test.ts` (merge con gate-failed + excluded-solo
    sin ranker failures). ADR-016 addendum documenta el cierre.

- **Drift fixes post-F4-009 smoke** ✅ done — 2026-04-21 — Bloque 7.
  Commit `51c6295` (`fix(matching): resolve skills table name + smoke
selector drift`):
  - `skills_catalog` → `skills` en `src/lib/matching/db-deps.ts:206`
    y `src/app/api/matching/runs/[id]/evidence/route.ts:82`. El
    catálogo vive en `skills` (ADR-013); el nombre viejo nunca
    existió en el schema. El bug era silencioso porque `rescueHook`
    swallowea errores y el evidence panel sólo se renderiza en
    drawer.
  - `smoke.spec.ts:34 "status filter narrows"` Playwright strict-mode
    violation resuelta: `getByLabel('Status')` matcheaba dos selects
    (el `<label>` envuelve todo → accessible name concatena option
    text → "StatusAny status..." y "JobAny job..." ambos matchean).
    Fix con `page.locator('label',{hasText:/^Status/}).locator('select')`
    — scope por elemento label con regex anclado.

- **F4-009 smoke E2E UC-11** ✅ done — 2026-04-21 — Block 6. `6806323`.
  `tests/e2e/matching-smoke.spec.ts` (6 tests, todos pasando contra
  local Supabase): render `/matching/new` form, `/matching/runs/:id`
  con Alice rank 1 score 100.0 passed gate, drawer con React cell +
  evidence panel, `/admin/skills` search encuentra link e2e-react,
  `/admin/skills/uncataloged` surfaces zig alias, `/admin` landing con
  ambos cards. El path `/matching/new → decompose → run` queda diferido
  a suite `@deep` con LLM stubeado (no live calls en smoke). `seed.ts`
  extendido para wipear `job_queries` por content_hash prefix + skills
  por slug prefix; seedea skill `e2e-react` + Alice + file con
  `parsed_text` mencionando React/Zig + extraction + experience + 2
  experience_skills (react resuelto + zig uncataloged) + job_queries
  con resolved_json/decomposed_json + match_run completed + match_results
  rank=1 score=100 breakdown_json. `global-setup.ts` escribe los ids
  seedeados a `playwright/.auth/e2e-ids.json`. **Observación**:
  `smoke.spec.ts:34 "status filter narrows"` falla con strict mode
  violation en `getByLabel('Status')` (matchea también el Job select
  añadido en sesiones anteriores); drift pre-existente no relacionado
  con F4-009.

- **F4-009 /admin/skills CRUD** ✅ done — 2026-04-21 — Block 5. `1acea1a`.
  ADR-013 §6. `src/lib/skills/admin-service.ts`:
  - `listSkills({search, includeDeprecated, limit, offset})` con
    `.or('slug.ilike...,canonical_name.ilike...')` + nested
    `skill_aliases(id)` para `alias_count`, orden `slug asc`,
    paginación por range.
  - `getSkill(id)` retorna `SkillDetail` con aliases + usage_count
    desde `experience_skills`.
  - `updateSkill` — canonical_name + category editables, slug
    immutable (referenciado por experience_skills.skill_id; rename =
    deprecate + recreate).
  - `setDeprecated` soft-delete por `deprecated_at` (ADR-013 §1).
  - `addAlias` idempotente si mismo skill, `alias_conflict` si otro;
    `removeAlias` hard delete (solo aliases, nunca skills).
  - Server actions `updateSkillAction / setDeprecatedAction /
addAliasAction / removeAliasAction` con `requireRole('admin')` +
    `revalidatePath` a /admin/skills, /admin/skills/:id, /admin.
  - Páginas: `/admin/skills` (list con search form, deprecated toggle,
    paginación, total count) y `/admin/skills/[id]` (editor client
    con canonical/category inputs, deprecate/undeprecate toggle, alias
    add/remove mostrando source seed/admin/derived).

- **F4-009 uncataloged admin surface** ✅ done — 2026-04-21 — Block 4.
  `a3b45c9`→`693cd3b`→`0bc535a`. ADR-013 §5. TDD RED→GREEN:
  `src/lib/skills/uncataloged.test.ts` (6 tests) drive
  `aggregateUncataloged(rows, blacklist)`: agrupa por forma
  normalizada (lowercase + whitespace-collapse), descarta
  null-normalized, excluye blacklist, mantiene ≤3 samples en
  first-seen order, sort count desc → alias asc.
  `src/lib/skills/uncataloged.ts`: `SAMPLES_PER_GROUP=3`,
  `FETCH_CAP=5000`, `listUncataloged(db)` devuelve `{groups,
truncated}` sobre `experience_skills` + `skills_blacklist`;
  `countUncatalogedRows(db)` head count; `addSkillToCatalog(db,
{slug, canonical_name, category?, aliases})` valida slug contra
  `SLUG_RE` + pre-flight de slug + alias conflicts + inserta skill +
  aliases source='admin' + `reconcileUncatalogedSkills`;
  `blacklistAlias(db, rawAlias)` idempotente via PG 23505 swallow.
  `UncatalogedAdminError` con codes `invalid_slug | invalid_name |
invalid_alias | slug_conflict | alias_conflict | db_error |
reconcile_failed`. Server actions
  `addToCatalogAction(input): ActionResult<AddSkillResult>` +
  `blacklistAction(aliasNormalized): ActionResult` con
  `requireRole('admin')` + revalidatePath de /admin/skills/uncataloged
  y /admin. Página server `/admin/skills/uncataloged` + client
  `uncataloged-row.tsx` con `useTransition`, form inline (canonical +
  slug + category opcional), botones add + blacklist. Landing
  `/admin/page.tsx` ahora lista dos cards: Uncataloged (con badge de
  count) y Skills catalog.

- **F4-009 UI — matching flow** ✅ done — 2026-04-21 — Block 3 de
  la sesión. 3 rutas nuevas bajo `src/app/(app)/matching/`:
  - `/matching/new` (`page.tsx` + `new-match-form.tsx` client
    component): textarea con límite 20k, POST
    `/api/matching/decompose`, panel con seniority + languages +
    requirements (must/years/category/evidence_snippet/resolved),
    lista de `unresolved_skills`, botón "Run match" → POST
    `/api/matching/run` → `router.push('/matching/runs/:id')`.
  - `/matching/runs/[id]/page.tsx` + `results-table.tsx`: server
    rendering bajo RLS, metadata (status, candidates_evaluated,
    count, started_at), hidrata candidate names in-line, tabla con
    rank + score + `must_have_gate` badge; click expande drawer
    con breakdown (skill raw + must/unresolved pills + status +
    years + ratio + contribution + evidence company/date_range),
    language_match, seniority_match, link a `/candidates/:id`.
    Link superior a `/matching/runs/:id/rescues` con count.
  - `/matching/runs/[id]/rescues/page.tsx`: tabla ordenada por
    `fts_max_rank` desc, snippet highlighting `«…»` →
    `<mark class="bg-accent/20 text-accent">`, empty state con
    mensaje ADR-016-aware.
  - Sidebar (`src/app/(app)/sidebar.tsx`) extendido con
    `{ href: '/matching/new', label: 'Matching' }` entre Search y
    Shortlists.

- **F4-008 bis — match_rescues + FTS fallback** ✅ done — 2026-04-21 —
  Block 2 de la sesión. `6921fe0`..`54825c4`.
  - Migraciones: `20260421000004_match_rescues.sql` (PK compuesta
    (match_run_id, candidate_id) + trigger `enforce_match_rescues_insert_only`),
    `20260421000005_rls_match_rescues.sql` (own-run-or-admin SELECT
    - INSERT vía join a `match_runs.triggered_by`, parity con
      ADR-017; admin-only DELETE; sin UPDATE),
      `20260421000006_match_rescue_fts_search.sql` (RPC SQL stable
      `security invoker` cross-joineando `candidate_ids × skill_slugs`
      con `to_tsvector('simple',...)` + `plainto_tsquery` +
      `ts_rank`::real + `ts_headline` con `StartSel=«,StopSel=»`).
  - Servicio puro `src/lib/rag/complementary-signals.ts`:
    `fetchFtsRescues(candidates, deps)` con constantes
    `FTS_RESCUE_THRESHOLD=0.1` + `EVIDENCE_SNIPPET_LIMIT=5`, filtra
    estrictamente `> threshold`, descarta cruzados, groupBy
    `skill_slug` ordenado por ts_rank desc luego snippet asc,
    orden determinístico por candidate_id asc. 9 unit tests.
  - Orchestrator (`src/lib/matching/run-match-job.ts`): nuevo hook
    opcional `rescueFailedCandidates?` invocado post-`completeMatchRun`
    en try/catch swallow (bucket ortogonal al ranking, ADR-016 §1);
    `collectFailedCandidates` filtra `must_have_gate='failed'` +
    breakdown con `must_have && status !== 'match' && skill_id !== null`.
    `rescues_inserted?: number` añadido al resultado.
    4 tests nuevos; 13 totales en run-match-job.test.ts.
  - Wiring (`src/lib/matching/db-deps.ts`): resuelve `skill_id` →
    `skill_slug` via `skills_catalog`, invoca RPC
    `match_rescue_fts_search` con cast `ts_rank` number|string →
    Number, inserta en `match_rescues`.
  - API route `src/app/api/matching/runs/[id]/rescues/route.ts`:
    GET con 401/400/404/500 y shape
    `{ run_id, rescues: [{ candidate_id, missing_skills,
fts_snippets, fts_max_rank, created_at }] }` ordenado por
    `fts_max_rank` desc.
  - **Gap conocido (no bloqueante)** documentado en ADR-016 bajo
    "Gap conocido — rescue vs pre-filter": el pre-filtro actual
    (`preFilterByMustHave`) hace AND-intersection sobre
    `experience_skills`, así que un candidato cuyo CV menciona el
    skill en `parsed_text` pero cuya extracción LLM lo omitió queda
    fuera del ranker y nunca llega al bucket. Hoy el bucket cubre
    gate-failed con must-have parcial (subset menor). Fix propuesto
    (F4-008 ter): `preFilter` retorna `{included, excluded_ids}`; el
    rescue opera sobre excluded con must-haves completos como
    `missing_skill_slugs`.

- **Block 1 — candidate_languages persistence** ✅ done — 2026-04-21 —
  `ec53ed6`.
  - `deriveLanguages` cableado al worker de extracción (`src/lib/cv/extraction/worker.ts`):
    hook opcional invocado solo post-miss (no en cache hit), logea
    fallo a `sync_errors` con `entity='cv_derivation'` sin abortar
    la extracción.
  - `src/lib/matching/db-deps.loadLanguages` cableado contra tabla
    real `candidate_languages` (no-op previo removido).
  - 3 worker tests nuevos + `languagesInserted: 0` assertion en
    tests de empty-pending / backwards-compat. 14 worker tests.

- **F4-008 API + persistencia + e2e** ✅ done — 2026-04-21 —
  `c2c95ff`..`ae26fbc`. Resuelto el gate estructural por ADR-017
  (ver sección "Decisiones cerradas esta sesión").
  - **Sub-A** (`c2c95ff`→`6881294`): `src/lib/matching/load-candidate-aggregates.ts`
    `loadCandidateAggregates(candidateIds, deps) → CandidateAggregate[]`.
    Groups rows por candidate_id, corre `mergeVariants` para
    collapse cv_primary + linkedin_export, attach de languages.
    Deps inyectadas: `loadExperiences(ids)` + `loadLanguages(ids)`.
    Empty input → [] sin tocar deps. 9 unit tests.
  - **Sub-B** (`9830964`→`d8d4c16`): `src/lib/matching/pre-filter.ts`
    `preFilterByMustHave(jq, tenantId, deps) → candidateIds`.
    Sólo filtra por `must_have = true && skill_id ≠ null` (ADR-015
    Consecuencias: unresolved skill_id NO filtra para no ocultar
    candidatos por catalog drift). AND-intersection sobre todos los
    skills requeridos. 8 unit tests.
  - **Sub-C** (`fab3ccc`→`28744f2`): `src/lib/matching/run-match-job.ts`
    orchestrator `runMatchJob(input, deps) → {run_id,
candidates_evaluated, top}`. Flujo:
    `loadJobQuery → createMatchRun(status=running) → preFilter →
loadCandidates → rank → insertMatchResults → completeMatchRun`.
    On error: `failMatchRun(reason)` + rethrow. State-machine
    trigger de `match_runs` enforza la transición correcta.
    `tenant_id` del job_query se propaga a cada escritura (hedge
    ADR-003). 9 unit tests.
  - **Sub-D parcial** (`3ba25ac`→`7e98a38`): 3 API routes + wiring.
    - POST `/api/matching/run`: Zod (job_query_id UUID + top_n
      1..100 default 10, strip unknown), `requireAuth`,
      `current_app_user_id` RPC, `buildRunMatchJobDeps(supabase)`,
      error mapping (404 job_query_not_found, 500 match_run_failed).
      9 schema tests.
    - GET `/api/matching/runs/:id`: metadata bajo RLS. 400 si id
      no-UUID, 404 si no visible.
    - GET `/api/matching/runs/:id/results?offset=&limit=`: paginado
      ordenado por rank asc, Zod schema offset ≥0 default 0, limit
      1..200 default 50, exact count. 7 schema tests.
    - `src/lib/matching/db-deps.ts` wirea todas las deps contra el
      cliente RLS-scoped (no service role, CLAUDE.md #4 intacta).
      `fetchCandidatesWithAllSkills` hace AND-intersection
      in-memory (F1 scale, ~100 candidatos × N skills).
  - **Sub-D e2e DoD** (`ae26fbc`): `tests/integration/matching/run-match-job.test.ts`
    seedéa skills catalog + 20 candidates (5 strong con ambos
    must-haves a 8y; 10 medium a 3y; 5 missing postgres) + app_user
    - auth.user, corre decompose (stub) → runMatchJob contra
      service-role client, asserta: `status='completed'`,
      `candidates_evaluated=15` (5 excluidos por pre-filter),
      ranks 1..15 contiguos, scores monotónicos non-increasing,
      top-5 del DB = strong set, no excluded en results, todos
      `must_have_gate='passed'`, `top` API slice = DB rows 1..10,
      `breakdown_json` tiene `{breakdown, language_match, seniority_match}`.
      Un segundo `runMatchJob` sobre el mismo `job_query_id` crea un
      `run_id` nuevo (runs idempotentes no, job_query sí). Pipeline
      completo < 1.3s en local — holgura sobre el target DoD de 3s.
  - **Languages no-op**: `loadLanguages` devuelve `[]` — la tabla
    `candidate_languages` no existe en F1 y el raw_output →
    languages aún no se deriva. El bono ±5/-10 de ADR-015 §3 queda
    inerte. Documentado en doc-comment de `db-deps.ts`. Follow-up
    slice pendiente (ver sección "Siguiente").

- **F4-007 Deterministic matcher (ranker puro)** ✅ done — 2026-04-21 —
  `840d8f4`..`072c0dd`.
  - **Sub-A** (`840d8f4`→`7ab5a63`): `src/lib/matching/variant-merger.ts`
    pure `mergeVariants(input, options)`. Collapse cv_primary +
    linkedin_export por misma kind + company normalizada (strip
    Inc/LLC/SA/etc) + title compatible (igualdad, substring, o Jaccard
    ≥ 0.5) + overlap > 50% de fechas. Ganador cv_primary (dates,
    title, description); skills unioned preservando primary casing;
    `merged_from_ids` lex-sorted para determinismo. Near-miss
    diagnostics (overlap 0–50%) para UI hint "might be same role"
    sin auto-merge. Sort final: start_date desc NULLS LAST, id asc.
    13 tests: ADR tests 12–16 + adversariales (null company/title/
    dates, sin candidatos a mergear, re-ordering invariance).
  - **Sub-B** (`d3e8f03`→`298b151`): `src/lib/matching/years-calculator.ts` - `date-intervals.ts` primitives compartidas. `yearsForSkill(skillId,
experiences, {now})` → sweep-line merge de intervalos de
    experiencias `kind='work'` con ese skill_id (null skill_id nunca
    suma, ADR-015 §1 invariant). 13 tests: ADR tests 1–6 + adversariales
    (null start/end, end ≤ start data bug, contiguous intervals,
    gap counting).
  - **Sub-C** (`6e9434f`→`904ba54`): `src/lib/matching/score-aggregator.ts`
    pure `aggregateScore(jobQuery, candidate, {now})`. Per-requirement
    breakdown (candidate_years, years_ratio, contribution, status,
    evidence). Must-have gate rule: `must_have && skill_id !== null &&
ratio === 0` → failed; unresolved skill_id must-have NO falla
    gate (catalog drift no debe ocultar candidatos silenciosamente,
    ADR-015 §Consecuencias). Weights 2.0/1.0 normalizados, language
    delta ±5/-10, seniority delta ±5/0, clamp [0,100]. 13 tests:
    ADR tests 1, 7–11 + adversariales (partial ratio, empty reqs,
    unresolved must-have gate-safe, clamp).
  - **Sub-D** (`de91899`→`072c0dd`): `src/lib/matching/ranker.ts`
    `DeterministicRanker` implements `Ranker`. Orquesta: aggregateScore
    por candidato con catalogSnapshotAt como now, sort (total_score
    desc, candidate_id asc). Idempotente (ADR test 21). Diagnostics
    vacío por ahora; sub-bloques F4-008 wirean variant-merge y FTS
    fallback (ADR-016).

- **F4-007 bis description_tsv generated column** ✅ done — 2026-04-21 —
  `47889cb`..`a7146fa`. Migración `20260420000009_candidate_experiences_description_tsv.sql`
  agrega columna `description_tsv tsvector GENERATED ALWAYS AS
(to_tsvector('simple', coalesce(description, ''))) STORED` +
  `idx_candidate_experiences_description_tsv` GIN. Integration test
  `tests/integration/db/candidate-experiences-description-tsv.test.ts`
  valida match por palabra, miss, y null description → tsvector vacío.
  Prerequisito de F4-008 bis (fallback FTS ADR-016).

- **F4-006 DecompositionProvider + job_queries** ✅ done — 2026-04-20 —
  `98dfb41`..`1cff526`. Sub-bloques RED→GREEN consolidados en sesión
  previa: provider interface + stub + OpenAI provider + prompts +
  orquestador + API route. Ver git log para detalle por sub-bloque.

- **F4-005 Derivación experiences + experience_skills** ✅ done — 2026-04-20 —
  `66e2045`..`685222a`.
  - **Sub-A** (`66e2045`→`f48777a`): `src/lib/cv/extraction/derivation.ts`
    como pure function. `deriveFromRawOutput(raw_output, context, catalog)`
    → `{ experiences, experienceSkills }`. Stitching por `temp_key`
    (el `experience_id` real solo existe post-insert). Date shape fill:
    `YYYY-MM → YYYY-MM-01`; null → null. Skills verbatim (ADR-012 §2
    invariant), `skill_id` vía `resolveSkill` inyectado; hit → id +
    marker `resolved_at`, miss → null/null. 10 unit tests.
  - **Sub-B** (`348d3c4`→`f530da5`): `src/lib/cv/extraction/derive-experiences.ts`.
    `deriveExperiences(extractionId, deps)` orquesta pure + DB.
    `loadExtraction` → short-circuit si `hasExistingExperiences=true`
    → `loadCatalog` una vez → `deriveFromRawOutput` →
    `insertExperiences` → stitch real ids vía `temp_key` map →
    `insertExperienceSkills` con `resolved_at` stamped real (ISO via
    `deps.now()`, null para miss). Errors: missing extraction throws,
    misstitch throws. 7 unit tests.
  - **Sub-C** (`c606ce0`→`685222a`): worker `runCvExtractions`
    firma cambiada — `insertExtraction` retorna `{id: string}`, deps
    opcional `deriveExperiences?`, nuevos counters
    `experiencesInserted` + `skillsInserted` + `derivationErrored`.
    Derivation error después de insert exitoso → sync_errors
    (entity='cv_derivation'), extracción persiste (idempotente por
    content_hash). CLI `src/scripts/extract-cvs.ts` wirea
    `buildDeriveDeps(db)` con loadCatalogSnapshot, insert positional
    N=N guard. Integration e2e `tests/integration/cv/derive-experiences`:
    2 tests — happy path (2 experiences + 3 skills con exact/alias/null)
    e idempotencia (segundo run = 0 writes, listPending NOT IN + guard
    derivación). 11 worker unit + 7 sub-B unit + 2 integration verde.

- **F4-004 ExtractionProvider + persistencia** ✅ done — 2026-04-20 —
  `4c2e4d9`..`9383358`.
  - **Sub-A** (`4c2e4d9`→`aecd368`): `src/lib/cv/extraction/{types,provider,stub-provider}.ts`.
    Zod schema ExtractionResult (ADR-012 §2) con dates ISO-8601 partial,
    strip de keys desconocidas. ExtractionProvider interface mirror del
    EmbeddingProvider. StubExtractionProvider determinístico (SHA-256
    del input) con inyección de fixture. 19 unit tests.
  - **Sub-B** (`90a2439`→`69ac920`): prompts/extract-v1.ts con constante
    `EXTRACTION_PROMPT_V1='2026-04-v1'` + texto pinneado (kind=work
    gating, date fallback YYYY-MM, skills verbatim, prohibición PII).
    providers/openai-extractor.ts usando chat.completions +
    response_format json_schema + Zod re-validation del content.
    fetchImpl inyectable. 15 unit tests (34 total).
  - **Sub-C** (`95c3492`→`9264990` + `6ffc787`): `extractionContentHash`
    = SHA256(parsed_text∥NUL∥model∥NUL∥promptVersion), NUL separator
    contra collisions por shift. `runCvExtractions(deps, opts)` con
    deps-injected I/O (listPending/extractionExistsByHash/insertExtraction/
    logRowError/provider), classifyVariant por file, skip si hash
    existe, row errors → sync_errors, batch continúa. 13 unit tests
    (47 total) + 3 integration tests (idempotencia, model bump
    invalida hash, provider failure aislado).
  - **Sub-D** (`9383358`): CLI `pnpm extract:cvs [--batch=N]` con
    env vars NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY +
    OPENAI_API_KEY (OPENAI_EXTRACTION_MODEL opcional). Exit codes
    0/2/4. LinkedIn parser determinístico postergado a Fase 2+
    (ADR-012 §2 lo describe, roadmap F4-004 DoD lo saca de scope F1).

- **F4-003 CV variant classifier** ✅ done — 2026-04-20 —
  `adac30c`..`8dcd483`.
  - **Sub-A** (`adac30c`→`4cf443b`): `src/lib/cv/variant-classifier.ts`
    como pure function (RED→GREEN). 13 unit tests adversariales:
    default seguro (empty/whitespace/plain CV), URL sola insuficiente,
    LinkedIn export positivos (full / sin URL / Top Skills+URL sin
    headers ordenados), headers solo-en-prosa no cuentan, case-sensitive,
    orden estricto, fechas "Month Year - Present", bound y determinismo.
    Scoring explícito en ADR-012 §1 respetado literalmente.
  - **Sub-B** (`8dcd483`): `tests/fixtures/cv-variants/{linkedin_export,cv_primary}/*.txt`
    con 5 fixtures cada uno + `variant-classifier.fixtures.test.ts`
    fixture-driven que itera la carpeta y asserta variant+confidence.
    Guard: ≥5 fixtures por variante (regression contra degradación de
    heurísticas nuevas). Fixtures sintéticos anonimizados, cubren
    shapes reales (full export, sin URL, prosa ATS shouting, prosa con
    "Please contact me", etc.).

- **F4-002 skills catalog seed + resolver** ✅ done — 2026-04-20 —
  `04a8736`..`2be40f1`.
  - **Sub-A** (`04a8736`→`8acc811`): `src/lib/skills/resolver.ts`
    como pure function (RED→GREEN). Types `CatalogSnapshot`,
    `SkillRow`, `AliasRow`, `Resolution`. `normalizeSkillInput`
    exportado para reusar en reporte admin. 18 unit tests
    adversariales mirror del contrato SQL.
  - **Sub-B** (`<post-8acc811>`): migración `20260420000008_skills_seed.sql`
    - `src/lib/skills/seed.ts` (65 skills, ~55 aliases) + helper
      `applyCuratedSeed` (upsert idempotente) para tests que wipean.
      5 sanity tests TS↔DB (slugs symmetric diff, canonical+category
      match, aliases, no duplicados, no alias=slug de otra skill).
      `resolve-skill-sql.test.ts` restaura seed en afterAll.
  - **Sub-C** (`2b82b9b`): `tests/integration/skills/resolver-equivalence.test.ts`
    — battery determinística de 41 inputs + sample real de aliases
    - sample real de slugs, total agreement TS↔SQL.
  - **Sub-D** (`2be40f1`): `src/lib/skills/catalog-loader.ts` +
    `src/lib/skills/reconcile.ts` + `src/scripts/skills-reconcile.ts`
    - `pnpm skills:reconcile`. Idempotente (Set de seen-IDs evita
      doble-count), preserva `resolved_at` original en filas con
      skill_id ya set. 4 integration tests.

- **F4-001 schema + RLS** ✅ done — 2026-04-20 — `7fd5663`..`cbbc70e`.
  - **Sub-bloque 1** (`7fd5663`): `skills`, `skill_aliases`,
    `skills_blacklist` + `public.resolve_skill(text)` helper con trim
    regex. RLS: público R, admin W.
  - **Sub-bloque 2** (`a31a1c5`): `candidate_extractions` +
    `candidate_experiences` + `experience_skills` con trigger
    `enforce_raw_output_immutability()` (bloquea hasta service
    role). `source_variant` (renombrado desde `cv_variant` por
    drift vs data-model). 21 tests RLS + invariants.
  - **Sub-bloque 3** (`f959378`): `job_queries` con trigger
    `enforce_job_queries_immutability()` sobre 6 columnas (decomposed_json,
    content_hash, normalized_text, model, prompt_version, created_by).
    Helper nuevo `public.current_app_user_id()` (SECURITY DEFINER,
    primer consumer de ownership-scoped RLS). 14 tests.
  - **Sub-bloque 4** (`cbbc70e`): `match_runs` + `match_results`.
    Trigger `enforce_match_runs_state_machine` (transición única
    'running' → 'completed'|'failed' con `finished_at` requerido;
    post-close todo frozen; identity cols siempre frozen). Trigger
    `enforce_match_results_insert_only` (rechaza UPDATE para todos,
    incluida service role). PK compuesta (match_run_id, candidate_id).
    RLS match_runs: recruiter R/W propios via `triggered_by`, DELETE
    admin-only. RLS match_results: SELECT via join a parent run, no
    UPDATE policy, INSERT/DELETE admin-only (worker usa service role).
    22 tests.
  - **ADR-016 Aceptada** (`78ae009`): complementary signals
    (estructurado + RAG + FTS) combinados sin corromper el contrato
    del ranker. 3 integraciones bounded: `match_rescues` post-ranker,
    evidence panel UI con `hybrid_search_fn`, generated column
    `candidate_experiences.description_tsv`. Roadmap F4-007bis
    (3h) + F4-008bis (4h) + F4-009 ajustado a 20h.

- **F4 planning end-to-end** ✅ done — 2026-04-20 — `085c079`..`7a2c1fd`.
  - **use-cases.md**: UC-11 "Matching por descomposición de llamado"
    (actor, goal, flow de 8 pasos, sequence diagram, 8 acceptance
    criteria). Insertado entre UC-08 y UC-09.
  - **spec.md**: §2.6 nueva (matching por descomposición), §10
    Fase 4 con F4 como primer item, §12 con 3 riesgos nuevos
    (PII en provider LLM, costo LLM, CV-vs-realidad drift).
  - **ADR-012** (Extracción estructurada de CVs, Aceptada —
    `790008d`): clasificador determinístico de variants,
    `ExtractionProvider` abstraction con OpenAI `gpt-4o-mini`,
    `candidate_extractions` con `content_hash = SHA256(parsed_text
|| NUL || model || NUL || prompt_version)`, prompt versionado
    con bump manual, weight por variant derivado en ranker (no en
    schema).
  - **ADR-013** (Catálogo de skills, Aceptada — `e3c0e85`): dos
    tablas `skills` + `skill_aliases` con resolver determinístico
    TS + helper SQL mirror (`public.resolve_skill`),
    `experience_skills.skill_id` nullable, seed curado + CLI
    reconcile, admin UI `/admin/skills/uncataloged`,
    `skills_blacklist` para términos tóxicos.
  - **ADR-014** (Decomposition LLM de job descriptions, Aceptada —
    `f76d9fd`): pipeline preprocess → hash → cache lookup → LLM
    (`gpt-4o-mini`) si miss → resolve skills → persist.
    `job_queries` con `decomposed_json` inmutable + `resolved_json`
    mutable (re-derivable contra catálogo vivo sin re-llamar LLM).
    Errores accionables si `unresolved_skills.length > 0`.
  - **ADR-015** (Matching & ranking, Aceptada — `bf87dae`): ranker
    determinístico puro (sin LLM, sin embeddings en F4).
    Years/skill via sweep-line merge de intervalos (solo
    `kind='work'`). Variant merging union con `cv_primary`
    autoritativa en duplicados (heurística company+title
    norm+date overlap > 50%). Must-have gate binario con sección
    aparte para fallos. Runs inmutables (`match_runs` +
    `match_results`) reproducibles via `catalog_snapshot_at`.
    21 tests listados. Budget 100 candidatos < 3s p50.
  - **data-model.md** §16: schemas SQL de las 9 tablas nuevas +
    `resolve_skill()` helper + matriz RLS extendida + ER diagram
    extendido. Invariantes: `decomposed_json`, `breakdown_json`,
    `raw_output` inmutables post-insert.
  - **roadmap.md**: F4-001..F4-009 slices con prompts listos,
    DoD, estimación. Viejo F4-003 "Scoring y matching" DROPPED
    por superseded.
  - **`_pending-decisions-f4.md` eliminado** (`7a2c1fd`): las 5
    decisiones P1-P5 quedaron consolidadas en las ADRs.

- **F3-001 evaluation slice** ✅ done — 2026-04-19 — `f307b3a`.
  - `src/lib/embeddings/sources/evaluation.ts`: source builder que
    agrega `evaluations` + `evaluation_answers` en un input por
    candidate. Orden cronológico de evals, orden lexicográfico de
    answers por `question_tt_id`, typed-column picker para
    number/boolean/date/range. Devuelve `null` cuando toda la data
    está vacía — el runtime salta la row.
  - `src/lib/embeddings/evaluation-worker.ts`: handler del
    `runEmbeddingsWorker` compartido. `source_type='evaluation'`,
    `source_id=null` (1 row por candidate).
  - `src/scripts/embed-evaluations.ts` + `pnpm embed:evaluations`.
    `embed-all` corre ahora `profile → notes → cv → evaluation`
    (el aggregate pesado queda último).
  - 9 tests unitarios en `evaluation.test.ts` (null cuando todo
    vacío, sort chronological, determinism bajo reshuffling,
    typed-column fallback, questionTitle→questionTtId fallback,
    header decision/score, no leaks de "null"/"undefined", collapse
    de whitespace). 226/226 unit tests verdes.

- **RLS tests para `evaluation_answers`** ✅ done — 2026-04-19 — `cbbc5b5`.
  - `tests/rls/evaluation-answers.test.ts`: 4 tests (anon SELECT
    denied, recruiter SELECT ok + INSERT denied, recruiter UPDATE +
    DELETE denied con re-read de service-role para confirmar que no
    es un zero-row silent success, admin R/W end-to-end).

- **F2-002 rejection normalizer dry-run CLI** ✅ done — 2026-04-19 — `4b06e3f`.
  - `src/scripts/normalize-rejections.ts` + `pnpm normalize:rejections`.
    Flags: `--dry-run` (clasifica + imprime samples, no escribe),
    `--force` (reclasifica incluso las ya normalizadas), `--batch=N`.
  - `src/lib/normalization/normalizer.ts`: agregado `dryRun?: boolean`
    y `samples[]` en el resultado (hasta 10 {reason→code}) para que
    el operador pueda spot-checkear. Integration test adicional
    verifica que dry-run NO escribe `rejection_category_id` ni
    `normalization_attempted_at`.
  - Workflow: `pnpm normalize:rejections --dry-run` → revisar
    samples → `pnpm normalize:rejections` para aplicar → revisar
    la cola `/admin/needs-review` para los fallbacks a `other`.

- **F2-004 needs_review admin UI** ✅ done — 2026-04-19 — `c0479b5`.
  - Cierra la mitad pendiente de F2-004 (la parte `sync_errors`
    había aterrizado el 2026-04-18).
  - `src/lib/needs-review/{service,errors}.ts`: `listNeedsReview` +
    `countNeedsReview` + `listRejectionCategories` +
    `reclassifyAndClear` + `dismissAndClear`. El reclassify valida
    que la categoría exista y no esté `deprecated_at`; bloquea
    doble-write con guardas `already_cleared`.
  - `/admin/needs-review/page.tsx` + `ReviewRow` client component:
    dropdown con categorías activas + botón "save" (reclasifica y
    limpia flag) + botón "dismiss" (acepta fallback `other`). Links
    a perfil de candidate desde el header de la row.
  - Landing `/admin` suma tarjeta "Needs review" con badge de
    pendientes (warning si >0).
  - 8 integration tests: lista + join a candidates, count, sort de
    categorías (other con sort_order=999 → último), reclassify
    happy, reclassify con UUID inexistente → error
    `invalid_category`, reclassify sobre row ya clara → error
    `already_cleared`, dismiss happy, dismiss sobre ya clara → error.

- **F3-002 `/search/semantic` page** ✅ done — 2026-04-19 — `8d47297`.
  - Server-rendered: form GET sobre `?q=`, llama a
    `semanticSearchCandidates` directo con client RLS-scoped (no
    round trip por `/api/search/semantic`), hidrata via nuevo
    `lib/search/hydrate.ts` (orden-preservante). Render con badge
    de score + source badges (profile/notes/cv/eval).

- **F3-003 `/search/hybrid` page** ✅ done — 2026-04-19 — `8d47297`.
  - Misma estrategia: GET form con `q` + filtros structured
    (status, rejected_after/before, job). Provider se resuelve lazy
    solo cuando hay query (structured-only no necesita
    `OPENAI_API_KEY` — mirror de `/api/search/hybrid`). Status line
    muestra el modo efectivo (`hybrid` | `structured` | `empty`).
  - Sidebar suma entry "Search" → `/search/hybrid`.

- **Smoke-test seeding knobs (`SYNC_MAX_RECORDS` + `SYNC_SCOPE_BY_CANDIDATES`)** ✅ done — 2026-04-19.
  - Motivador: traer 50 candidatos con data completa a local para
    smoke-test manual sin un full backfill.
  - `SyncerDeps.maxRecords?: number` en `src/lib/sync/run.ts`: runner
    corta pagination al llegar al cap. Undefined = sin cap. Cuenta
    resources yielded desde TT, no solo los que upsertan ok.
  - `SyncerDeps.scopeCandidateTtIds?: ReadonlySet<string>` consumido
    por applications/notes/interviews/uploads: filtra staging antes
    de FK resolution. Rows fuera de scope se descartan silenciosa­
    mente — **no** van a `sync_errors`. Uploads además skippea el
    download del binario (no pagamos bytes que íbamos a tirar).
  - CLI (`src/scripts/sync-incremental.ts`) lee `SYNC_MAX_RECORDS`
    (positive int) y `SYNC_SCOPE_BY_CANDIDATES` (1/true), y cuando
    scope está activo carga los teamtailor_id de `candidates` en un
    Set y los pasa via deps.
  - TDD full: commits `f302016` (RED cap) → `bcd195e` (GREEN cap) →
    `69f863e` (RED scope) → `8ff73c7` (GREEN scope) → `5ce5103` (CLI
    wiring). `.env.example` actualizado.
  - Workflow smoke-test:
    ```
    pnpm sync:incremental stages
    pnpm sync:incremental users
    pnpm sync:incremental jobs
    pnpm sync:incremental custom-fields
    SYNC_MAX_RECORDS=50 pnpm sync:incremental candidates
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental applications
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental notes
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental evaluations
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental files
    ```
  - 415/415 tests verdes (244 unit + 113 integration + 58 RLS).

- **Remediación F3-002/F3-003 (audit de procedimiento)** ✅ done — 2026-04-19.
  - Usuario cuestionó el bundle anterior por bypass de TDD
    ([GREEN] sin [RED] previo) y falta de ADR para el patrón
    server-rendered. Remediación en 4 pasos:
    1. `tests/integration/search/hydrate.test.ts` — 6 tests
       retro-cobertura de `hydrateCandidatesByIds` (order
       preservation, RLS drop, empty input, dedupe, ids
       inexistentes, mapeo full de card fields). Commit `11a2421`.
    2. Full suite verde: 217 unit + 110 integration + 58 RLS = 385
       tests. Sin regresiones del bundle.
    3. `docs/adr/adr-011-server-rendered-search-pages.md` — pattern
       documentado (form GET + server render + service call directo +
       lazy provider + RLS hydration), alternativas descartadas,
       triggers de reevaluación. Commit `c0746ac`.
    4. Chronicle: 3 memorias persistidas (vitest script gotcha,
       pattern architectural, TDD-gap insight).

- **F1-011 CV viewer tab** ✅ done — 2026-04-18.
  - `src/app/api/files/[id]/signed-url/route.ts`: `GET` que mintea un
    URL firmado de 1h al bucket privado `candidate-cvs`. Auth: cualquier
    usuario autenticado (recruiter o admin); RLS sobre `files` ya
    enforce el matriz de visibilidad — `maybeSingle()` null = 404 sin
    distinguir "no existe" de "RLS lo escondió". Soft-deleted → 410.
    Resuelve `fileName` desde `raw_data.originalFileName` (uploads
    manuales) o `raw_data.attributes.fileName` (TT-synced) con
    fallback al basename del `storage_path`. URL no se persiste; se
    mintea on-click para que no quede en el HTML rendered.
  - `src/app/(app)/candidates/[id]/open-file-button.tsx`: client
    component que hace fetch del signed-url y `window.open` con
    `noopener,noreferrer`. Estado de loading con `useTransition` y
    error inline.
  - `src/app/(app)/candidates/[id]/page.tsx`: nueva sección
    "Currículums" lista los `files` con `kind='cv'` (no
    soft-deleted), muestra nombre + tipo + estado de parseo, y un
    botón "Abrir" por archivo. La sección "Planilla VAIRIX" ahora
    también renderiza un botón "Abrir" cuando hay archivo subido. El
    placeholder "More coming soon" queda solo para evaluations + notes.
  - 9 tests adversariales en `src/app/api/files/[id]/signed-url/
route.test.ts` (401 unauth, 400 invalid_id, 400 SQL-injection
    shape, 404 not visible, 410 soft-deleted, 500 sign failure,
    happy path con TTL ~1h, fallback `attributes.fileName` para
    TT-synced, fallback al basename). 271/271 unit tests verdes.
  - Downstream: el parser marca `parse_error` y se muestra inline en
    la lista; el operador puede abrir el binario para diagnosticar.

- **F1-011 Evaluations + Notes sections** ✅ done — 2026-04-18.
  - `evaluations-section.tsx`: lista cada `evaluations` (candidate
    interview scorecard) con decisión + score + evaluator + notes +
    las `evaluation_answers` estructuradas (scorecard custom
    questions). Typed-column picker para answer values (value_text /
    value_number / value_range / value_boolean / value_date).
  - `notes-section.tsx`: lista cada `notes` (Teamtailor free-form)
    con author + body + fecha. Read-only — la creación sigue en TT.
  - Ambos fetchs son server-side bajo RLS, dispatcheados en el
    `Promise.all` del page para paralelizar.
  - **Refactor**: page.tsx bajó de 507 → 127 líneas extrayendo 6
    secciones a archivos propios (`applications-section.tsx`,
    `metadata-vairix-section.tsx`, `vairix-sheet-section.tsx`,
    `profile-header.tsx`, + las dos nuevas). Todos los archivos ≤ 300
    líneas cumpliendo `CLAUDE.md §Code Standards`. 262/262 tests verdes.
  - Removido el placeholder "More coming soon" — todas las tabs de
    F1-011 están implementadas (identity, metadata, applications,
    VAIRIX sheet, CVs, evaluations, notes, tags, shortlists).

- **F1-008 CV parser worker** ✅ done — 2026-04-18 — commits
  `6f3cd33` (dispatcher previo) → `d50c26c` (RED) → `5de9156`
  (GREEN) → `cab9bfe` (CLI + integration test).
  - `src/lib/cv/parse-worker.ts`: runtime puro (I/O inyectado) que
    pulla filas pendientes (`deleted_at IS NULL AND parsed_text IS
NULL AND parse_error IS NULL`), descarga por `storage_path`,
    dispatcha a `parseCvBuffer`, y escribe el resultado. Las filas
    terminales (parseadas o con error) no se reprocesan; para
    reintentar un error hay que poner `parse_error=null` a mano.
    Errores de descarga se clasifican como `parse_failure`.
  - `src/scripts/parse-cvs.ts`: CLI `pnpm parse:cvs [--batch=N]`
    (default 50). pdf-parse + mammoth se importan lazy así los
    scripts de sync/embeddings no pagan el costo.
  - 6 unit tests (`src/lib/cv/parse-worker.test.ts`) + 1 integration
    test (`tests/integration/cv/parse-worker.test.ts`) que seedea
    Supabase + Storage locales con 2 pending + 1 parseada + 1 errored,
    corre el worker, verifica que sólo tocó las pendings, y prueba
    que un segundo run es no-op. 348/348 tests verdes.
  - Downstream: F3-001 cv embeddings ya consume `parsed_text` via
    `cvSourceHandler` — no requiere cambios.

- **F1-007 CV download + Storage** ✅ done — 2026-04-18 — commits
  `f53955a` (migration + bucket) → `480077a` (RED downloader) →
  `413f1ba` (GREEN downloader) → `f823860` (uploads syncer + CLI) →
  `ef9bc30` (F1-006b upload endpoint) → `8b2cacc` (F1-006b admin UI).
  - Migration `20260418235000_candidate_cvs_bucket.sql`: crea el
    bucket privado `candidate-cvs` (10 MB cap, MIME whitelist
    pdf/doc/docx/xls/xlsx/csv/txt/rtf), agrega `files.is_internal
boolean not null default false`, y dos policies `storage.objects`
    (recruiter+admin SELECT por bucket_id, admin ALL). Idempotente
    (`on conflict (id) do update`).
  - `src/lib/cv/downloader.ts`: `downloadAndStore(args)` hace fetch
    del URL firmado de TT, SHA-256, y sube a
    `<candidate_uuid>/<file_uuid>.<ext>` con `upsert: true`. Si
    `existingHash === contentHash`, salta el upload y devuelve
    `uploadedFresh: false` (skip idempotente del binario — ADR-006
    §2). 10 tests adversariales (HTTP !== 2xx, hash match/mismatch,
    storage error, content-type inference).
  - `src/lib/sync/uploads.ts`: syncer factory
    `makeUploadsSyncer({ storage, fetch?, randomUuid? })` que
    consume `/v1/uploads?include=candidate`. Reusa `files.id` cuando
    el `teamtailor_id` ya existe, pasa `existingHash` al downloader,
    y si `uploadedFresh` inserta fila con `parsed_text/parsed_at/
parse_error = null` (invalida el parser — ADR-006). Row-level
    errors (orphan FK, download failure) → `sync_errors`; batch no
    aborta. Entity key es `files` (matches seed de `sync_state`).
  - `src/scripts/sync-incremental.ts`: registra
    `files: makeUploadsSyncer({ storage: db.storage.from('candidate-cvs') })`.
    Ejecutable con `pnpm sync:incremental files`.
  - **F1-006b upload manual (admin-only)**: endpoint POST
    `/api/candidates/[id]/vairix-sheet` acepta multipart/form-data
    (xlsx/xls/csv/pdf, ≤10 MB) y hace soft-delete del
    `vairix_cv_sheet` activo anterior antes de insertar la nueva
    fila (satisface el partial unique index de `20260418230000`).
    `is_internal=true`. UI: `VairixSheetUpload` client component
    renderizado sólo cuando `auth.role === 'admin'` en el profile.
  - **Integration test cerrado** `3e05bd4` — 3 tests E2E contra
    Supabase local + Storage con TT y binary URLs mockeados por MSW:
    happy path (2 files subidos + orphan en sync_errors + bytes en
    bucket), idempotencia (re-run con mismos binarios preserva
    parsed_text), binary change (nuevo hash + parsed_text reset a
    null). Lockea el contrato content-addressed contra regresiones.
  - **Tipos DB regenerados** — `pnpm supabase:types` no produjo
    cambios: `is_internal` ya estaba en `src/types/database.ts`.
  - **Pendiente para próxima sesión**: probe manual del sync
    completo contra el tenant VAIRIX (dry-run con `page[size]=5`
    antes de un run completo, siguiendo la regla de validación
    incremental).

- **F1-007 desbloqueado** ✅ 2026-04-18 — probe en
  `src/scripts/probe-uploads.ts` confirmó que `/v1/uploads` existe
  top-level, `include=candidate` popula la relationship, atributos
  son `url` (S3 signed, expira), `fileName`, `internal` (bool),
  `createdAt`, `updatedAt`. Sin `size`/`mimeType` — derivar de la
  extensión (.pdf/.doc/.docx → cv, .xlsx/.csv → vairix_cv_sheet).
  Detalle completo en `docs/teamtailor-api-notes.md §5.7`. F1-007
  pasa de 🚫 BLOCKED a 🔓 UNBLOCKED. Pendiente de input del usuario
  sobre política del bucket `candidate-cvs` antes de implementar el
  downloader.

- **F1-006b VAIRIX CV Sheet filter + profile section** ✅ done —
  2026-04-18 — commits `2604b7c` (migration files.kind) → `c0d0418`
  (RED search) → `2582a9a` (GREEN search filter) → `6f4fbff` (UI:
  list toggle + profile section).
  - **Alcance simplificado a pedido del usuario**: se difiere la
    integración con Google Drive/Sheets hasta terminar el resto del
    roadmap. En su lugar esta iteración entrega dos cosas concretas:
    (a) filtro `has_vairix_cv_sheet` en `/candidates` que matchea por
    `evaluation_answers.value_text` con `question_tt_id='24016'`
    ("Información para CV") **o** por `files.kind='vairix_cv_sheet'`
    no soft-deleted, y (b) sección "Planilla VAIRIX" en
    `/candidates/[id]` que muestra la URL clickeable de TT y el
    nombre del archivo subido (si lo hay).
  - Migration `20260418230000_files_kind.sql`: agrega `kind` a
    `files` (`cv | vairix_cv_sheet`) + partial unique index por
    candidato + índice en `kind`.
  - Backend `src/lib/search/search.ts`: `candidateIdsWithVairixCvSheet()`
    une los dos orígenes (TT URL + archivo) y se intersecta con los
    filtros de applications ya existentes. 3 tests adversariales
    nuevos (URL match, file match, `hasVairixCvSheet=false` tratado
    como sin filtro).
  - UI: `SearchForm` agrega un checkbox "Only candidates with a VAIRIX
    CV sheet"; el perfil muestra la URL cuando existe y un placeholder
    "Carga manual disponible en F1-007 (bucket de Storage)" porque el
    endpoint de upload depende de que F1-007 cree el bucket
    `candidate-cvs` con RLS. Esa parte queda para F1-007.

- **F1-006a interviews/evaluations ingest** ✅ done — 2026-04-18 —
  commits `ab61d0b` (migration) → `7b346e9` (RED) → `1f8ef78` (GREEN).
  - **Descubrimiento clave**: `/v1/interviews` está expuesto por TT
    (1908 registros en el tenant VAIRIX) a pesar de no estar en la
    docs pública. Carga `note`, `status`, relationships candidate/
    job/user y sideload `answers`/`questions`. Esto **unbloquea F1-006
    desde TT** sin depender de Google Docs. La planilla CV por
    candidato sigue externa (F1-006b pendiente, pide auth a Google).
  - Migration `20260418220000_evaluation_answers.sql` +
    `20260418220001_rls_evaluation_answers.sql`: scorecard Q&A con
    columnas tipadas (`value_text|number|boolean|date|range`) keyed
    by `question_tt_id`. Evita bakear IDs custom del tenant en schema.
    Policies espejan `evaluations` (recruiter R, admin R/W).
  - `src/lib/sync/interviews.ts`: syncer con `includesSideloads=true`
    y `include=answers,answers.question`. Candidate requerido →
    orphan a `sync_errors`. Resuelve `application_id` por
    `(candidate_id, job_id)` lookup. Idempotente.
  - Wired a CLI como `pnpm sync:incremental evaluations`.
  - 2 integration tests (happy path + idempotencia) + fixture con
    la URL real de "Información para CV" (q=24016) intacta.

- **Embeddings worker hardening** ✅ done — 2026-04-18 — rango de
  commits `28181bc..6d2e4f6`.
  - `src/lib/embeddings/worker-runtime.ts` — runtime compartido para
    los workers por-source. Los tres workers (profile/notes/cv) pasan
    a ser wrappers de ~80 líneas que sólo aportan su loader
    `buildContents`. Elimina ~250 líneas duplicadas.
  - **Bug latente arreglado**: los workers usaban `.limit(batchSize=500)`
    como tope hard, descartando silenciosamente candidatos >500. El
    runtime ahora paginea con `.range()` hasta agotar. Test de
    regresión `worker-pagination.test.ts` (7 candidatos / batchSize=3
    → 3 páginas, todos embebidos).
  - **Logs estructurados** (JSON a stderr) en cada `embed.page` y
    `embed.done`, con pageSize, totales, `reuseRatio`, `durationMs`
    — base de observabilidad sin decisión de destino (subset de
    F2-005).
  - CLI `pnpm embed:all` que corre profile → notes → cv
    secuencialmente; aborta en la primera falla.

- **Adversarial schema coverage** ✅ done — 2026-04-18 — 35 tests
  (commit `647d2ab`).
  - Exporta `semanticSearchRequestSchema` y `hybridSearchRequestSchema`
    y cubre los bordes de Zod: query vacía/over-sized/non-string,
    limit fuera de rango/no-entero, sourceTypes desconocidos/excedido,
    UUID inválido en jobId, datetime no-ISO, status desconocido,
    coerción empty-string → null, SQL-injection-looking strings
    (pasan verbatim — parameterization downstream).

- **F3-001 cv slice** ✅ done — 2026-04-18 — CV source para el
  embeddings worker (ADR-005 §Fuentes a embeber), rango de commits
  `11965ca..83996a7`.
  - `src/lib/embeddings/sources/cv.ts` — `buildCvContent` elige el
    CV más reciente por candidato (parsed_at desc, tie-break por
    id), ignora files soft-deleted y files sin parsed_text, colapsa
    whitespace y trunca a `CV_CONTENT_MAX_CHARS=30000` (margen
    sobre el límite de 8192 tokens del modelo, Fase 1 trunca al
    primer chunk).
  - `src/lib/embeddings/cv-worker.ts` — `runCvEmbeddings` mirrors
    el notes-worker: una fila por candidate
    (`source_type='cv'`, `source_id=null`), idempotente vía
    `content_hash` (sal=provider.model). Invalida la caché cuando
    se agrega un CV más nuevo o cambia el parsed_text del último.
  - `src/scripts/embed-cv.ts` + `pnpm embed:cv` (flag `--stub`).
  - Tests: 8 unit (`sources/cv.test.ts`) + 4 integration
    (`cv-worker.test.ts`). Total del repo: 270.
  - Pendiente de F3-001: source `evaluation` (bloqueado por F1-006
    evaluations ingest).

- **F3-003** ✅ done (base, sin UI) — 2026-04-18 — Hybrid search
  (UC-01), rango de commits `1f14e69..a98b743`.
  - Migración `20260418210000_hybrid_search_fn.sql` — extiende
    `semantic_search_embeddings` con parámetro `candidate_id_filter
uuid[] default null` para empujar el filtro al RPC y que el
    planner prune el scan ivfflat a la intersección con el set
    pre-filtrado. PostgREST resuelve tanto llamadas con 3 args
    (pure semantic) como 4 args (hybrid).
  - `src/lib/rag/hybrid-search.ts` — `hybridSearchCandidates`:
    resuelve filtros estructurales → candidate_ids, y después
    elige entre 3 modos: `hybrid` (query + filtros → rerank
    restringido), `structured` (sin query → devuelve ids sin
    ranking), `empty` (intersección vacía o input totalmente
    vacío). Garantiza que candidatos fuera del filtro **nunca**
    aparecen en el output ranqueado (propiedad core de UC-01).
  - `src/lib/rag/semantic-search.ts` — extendido con opción
    `candidateIds` que se propaga al RPC; backward-compat (default
    undefined ⇒ comportamiento previo).
  - `src/app/api/search/hybrid/route.ts` — `POST /api/search/hybrid`
    con Zod validando query nullable + filtros estructurados + limit
    - sourceTypes. Provider se resuelve **lazy**: structured-only
      no requiere `OPENAI_API_KEY`.
  - Tests: 4 integration (hybrid/structured/empty/date-filter).
    Los 9 tests previos de F3-002 siguen verdes (no regresión).
  - Pendiente: UI (cómo integrar esto al `/search` existente o como
    página separada).

- **F3-002** ✅ done (base, sin UI) — 2026-04-18 — Query de búsqueda
  semántica (ADR-005 §Consumo), rango de commits `26c8e53..9461dc4`.
  - Migración `20260418200000_semantic_search_fn.sql` — función
    `public.semantic_search_embeddings(query_embedding float8[],
max_results int default 20, source_type_filter text[] default null)`
    que devuelve `(candidate_id, source_type, score)` ordenado por
    proximidad coseno. `security invoker` → RLS de `embeddings`
    aplica; `set search_path = public, extensions` (ADR-009);
    casting interno `float8[]::vector` porque PostgREST no parsea
    el formato textual de pgvector.
  - `src/lib/rag/semantic-search.ts` — `semanticSearchCandidates`
    embeda la query y llama al RPC; short-circuit en query vacía;
    valida dimensión del vector; `dedupeByCandidate` colapsa hits
    por candidate_id tomando el mejor score y acumulando source
    types matcheados, ordenado score DESC.
  - Tests: 5 unit (dedupe helper) + 4 integration (end-to-end con
    stub provider, source filter, limit, exact-match ≈ 1.0).
  - `src/app/api/search/semantic/route.ts` — `POST /api/search/semantic`
    expuesto: body Zod `{query, limit?, sourceTypes?}`, 401 anon,
    503 si falta `OPENAI_API_KEY`, respuesta `{matches: [{candidateId,
bestScore, matchedSources}]}`. Comparte `resolveEmbeddingProvider()`
    con los dos CLIs (refactor que dedup-ea el switch stub/OpenAI).
  - Pendiente: UI (UC-02), hydration de candidate cards,
    hybrid search (F3-003).

- **F3-001** 🏃 en curso — 2026-04-18 — Pipeline de embeddings
  (ADR-005). Sources `profile` y `notes` landeados (`adae0c2..e6bd61e`).
  - Notes slice: `src/lib/embeddings/sources/notes.ts` (concatenación
    cronológica, whitespace normalizado, `null` cuando no hay nada
    útil), `src/lib/embeddings/notes-worker.ts` (mismo patrón que el
    profile worker: hash-based cache, 1 embedding por candidate con
    `source_id=null`, service-role requerido), `src/scripts/embed-notes.ts`
    - `pnpm embed:notes`. 11 tests nuevos (7 unit + 4 integration).
      Cubre first-run, idempotencia, cambio de note (regen) y cambio
      de modelo.

- **F3-001** ✅ done (profile source slice) — 2026-04-18 — Pipeline de embeddings (ADR-005), rango de commits `adae0c2..d36ba17`.
  - `src/lib/embeddings/provider.ts` — interfaz `EmbeddingProvider`
    ({ model, dim, embed(texts) }). Vendor lock-in confinado a los
    archivos de provider (ADR-005 §Consecuencias).
  - `src/lib/embeddings/hash.ts` — `contentHash(model, content)`:
    SHA-256 con separador `\x00` entre model y content. El model
    forma parte del hash → cambiar de modelo invalida todo el caché
    automáticamente.
  - `src/lib/embeddings/stub-provider.ts` — provider determinístico
    para tests y smoke-runs (sin OpenAI). Expande SHA-256 del texto
    a `dim` floats en [-1, 1). Misma entrada ⇒ mismo vector.
  - `src/lib/embeddings/openai-provider.ts` — wrapper thin sobre
    `POST /v1/embeddings`. Realinea la respuesta por `data[].index`.
    Short-circuit en input vacío. Retries/backoff fuera de acá
    (worker). 5 unit tests con `globalThis.fetch` stub.
  - `src/lib/embeddings/sources/profile.ts` —
    `buildProfileContent({firstName, lastName, headline, summary, tags})`:
    compone `"<first> <last> — <headline>\n<summary>\nTags: a, b, c"`
    (tags ordenadas + dedup), normaliza whitespace, devuelve `null`
    cuando no hay contenido útil ⇒ el worker skipea.
  - `src/lib/embeddings/profile-worker.ts` —
    `runProfileEmbeddings(db, provider, {candidateIds?, batchSize?})`:
    carga candidatos + tags + embeddings existentes en paralelo,
    compara hash (match ⇒ reuse), regenera solo lo cambiado, upsert
    manual (read-then-insert/update). Devuelve
    `{processed, skipped, regenerated, reused}`. 4 integration tests
    contra Supabase local con stub provider: first-run, idempotencia,
    content-change, model-change invalida todo.
  - `src/scripts/embed-profiles.ts` + `pnpm embed:profiles` —
    CLI con flag `--stub` para smoke. Exit codes 0/2/4.
  - **Sources pendientes** (mismo patrón, bloqueados por datos):
    `cv` (depende de F1-007/F1-008), `evaluation` (depende de F1-006
    evaluations), `notes` (desbloqueado; pendiente de implementar).

- **F2-004** ✅ done (parte sync_errors) — 2026-04-18 — Admin panel de ETL failures.
  - `src/lib/sync-errors/service.ts` — `listSyncErrors` (default
    unresolved-only, filter por entity, paginación offset+limit),
    `countSyncErrors` (head count con mismos filtros),
    `resolveSyncError` (guard not_found + already_resolved, setea
    `resolved_at`). Error class `SyncErrorAdminError` con codes
    tipados. 8 integration tests verdes.
  - `src/app/(app)/admin/sync-errors/page.tsx` — Server Component
    admin-only (`requireRole('admin')`): filtros por entity +
    includeResolved (GET form), tabla paginada (50/página) con
    badges de entity/error_code/resolved, payload colapsable en
    `<details>`. Inline `ResolveButton` vía server action +
    `useTransition` + `revalidatePath`.
  - `src/app/(app)/admin/page.tsx` — ya no es stub: tile que
    linkea a `/admin/sync-errors` con contador de unresolved.
  - **Pendiente (parte `needs_review`)**: la admin queue de
    rejections clasificadas como `other` depende de F2-002 corriendo
    sobre datos reales — bloqueado por F1-006 evaluations.

- **F2-002** ✅ done (código listo, sin datos en prod) — 2026-04-18 — Rejection normalizer (ADR-007).
  - `src/lib/normalization/rejection-rules.ts` — tabla versionada
    de 10 categorías con keywords ES+EN (technical_skills,
    experience_level, communication, culture_fit,
    salary_expectations, availability, location, no_show,
    ghosting, position_filled). Prioridad explícita.
  - `src/lib/normalization/classify.ts` — función pura
    `classifyRejectionReason(text)`. Case-insensitive, first-match-wins,
    fallback a `{ code: 'other', needsReview: true }`. 21 unit tests.
  - `src/lib/normalization/normalizer.ts` — orquestador
    `normalizeRejections(db, {force?, batchSize?})`: lee
    evaluations con `rejection_reason` no-null y category null
    (a menos que force=true), clasifica, escribe
    `rejection_category_id` + `needs_review` + `normalization_attempted_at`.
    Service-role client requerido (es un job interno post-sync,
    ADR-007 §2). 3 integration tests: batch mixto,
    idempotencia, force-reclassify.
  - **No corre en prod aún**: depende de F1-006 evaluations
    (bloqueado en TT endpoint — ver "Blockers" abajo). El código
    está listo para activarse apenas haya datos.

- **F1-013** ✅ done — 2026-04-18 — Shortlists CRUD + CSV export (UC-03).
  - `src/lib/shortlists/errors.ts` — `ShortlistError` con codes
    tipados (invalid_name, not_found, already_archived,
    already_in_shortlist, not_in_shortlist, db_error,
    app_user_not_found).
  - `src/lib/shortlists/service.ts` — reglas de dominio:
    `normalizeShortlistName` (trim, ≤120), `createShortlist`,
    `listActiveShortlists` (con `candidate_count` via embedded
    aggregate), `getShortlist`, `addCandidateToShortlist`
    (idempotente, bloquea en archived), `removeCandidateFromShortlist`
    (404 on non-member), `archiveShortlist` (rechaza double-archive),
    `listShortlistCandidates`, `candidatesToCsv` (RFC 4180).
  - `tests/integration/shortlists/service.test.ts` — 9 tests:
    normalización, lifecycle (create/list/add/remove/archive),
    idempotent add, archive-blocks-add, CSV escaping.
  - `src/app/(app)/shortlists/actions.ts` — server actions
    (`createShortlistAction`, `createShortlistAndRedirect`,
    `addCandidateAction`, `removeCandidateAction`,
    `archiveShortlistAction`) con `requireAuth` + `revalidatePath`.
  - `src/app/(app)/shortlists/page.tsx` — list + create form.
  - `src/app/(app)/shortlists/[id]/page.tsx` +
    `shortlist-detail.tsx` — detail con archive button, export
    CSV link, per-row remove; archived → read-only.
  - `src/app/api/shortlists/[id]/export.csv/route.ts` — GET
    route handler, `text/csv` + `Content-Disposition: attachment`,
    filename sanitizado.
  - `src/app/(app)/candidates/[id]/add-to-shortlist.tsx` — client
    component con `<select>` de active shortlists + input de nota
    opcional en el perfil del candidato.
  - Sidebar entry "Shortlists" agregado.

- **F1-012** ✅ done — 2026-04-18 — Tags: servicio + UI con creator-or-admin delete.
  - `src/lib/tags/errors.ts` — `TagError` con codes.
  - `src/lib/tags/service.ts` — `normalizeTagName` (trim+lowercase,
    ≤64), `ensureTag` (upsert race-safe), `addTagToCandidate`
    (idempotente), `removeTagFromCandidate` con guard
    **creator-or-admin** (recruiter solo borra sus propios tags),
    `listTagsForCandidate`, `listAllTagNames`.
  - `tests/integration/tags/service.test.ts` — 10 tests, incluye
    auth: recruiter borra su tag, admin borra cualquier tag,
    recruiter no-creador recibe `forbidden`. Helper
    `ensureAuthUser` crea usuarios reales en `auth.users` via
    `auth.admin.createUser` (app_users.auth_user_id tiene FK a
    auth.users).
  - UI: `candidate-tags.tsx` client component con datalist
    autocompletion + chips, optimistic UI via `useTransition`.

- **F1-008** ✅ done — 2026-04-18 — CV parser dispatcher.
  - `src/lib/cv/parse.ts` — `parseCV(file, deps)` dispatcher por
    MIME/extension: pdf, docx, txt; codes de error tipados
    (`unsupported_format`, `parse_failure`, `empty_text`,
    `likely_scanned`). Threshold `SCANNED_MIN_CHARS=200`.
    Normaliza CR/LF, colapsa tabs+espacios, tres o más newlines
    a `\n\n`. Deps inyectadas (`parsePdf`, `parseDocx`) para
    testear sin binarios reales.
  - `src/lib/cv/parse.test.ts` — 12 unit tests (happy path por
    formato, vacíos, scanned detection, unsupported, propagación
    de errores del provider).
  - **Pendiente F1-008 full**: wiring a Storage webhook +
    worker que hace `download → parseCV → upsert files.text +
content_hash`; ver F1-009 (embeddings pipeline).

- **F1-006** ✅ done — 2026-04-18 — notes syncer (UC-07 slice).
  - `tests/fixtures/teamtailor/notes-page-1.json` — 4 notes: happy
    path, FKs nulos (user/application opcionales), body vacío,
    candidate huérfano.
  - `src/lib/sync/notes.ts` + `notesSyncer` registrado en
    `SYNCERS` (post-users/applications). Valida relationship
    candidate + body no vacío (row-level `ParseError`);
    reconcilia FKs via `buildIdMap` para candidates/applications/users;
    orphan candidate → `sync_errors`.
  - `tests/integration/sync/notes.test.ts` — 2 integration tests.

- **Blockers documentados para el usuario** (requieren decisión humana):
  - **F1-007 evaluations syncer**: Teamtailor **no expone** el endpoint
    `/v1/evaluations`. Las evaluaciones reales viven en Google Docs
    por llamado (ver auto-memory `project_custom_data_sources.md`).
    Requiere definir la estrategia de ingest (scraping/manual/otro)
    antes de escribir código.
  - **F1-010 CV downloader / files syncer**: docs marcan el shape de
    `/v1/uploads` como `[VERIFICAR]`. Antes de escribir el syncer,
    confirmar contra una llamada real a TT qué formato viene (ej.
    vs. `/v1/candidates` with sideload). Una vez verificado, el
    parser (F1-008) ya está listo para consumir los archivos.

- **F1-006b** ✅ done — 2026-04-18 — ADR-010 core ingest de custom fields.
  - `docs/adr/adr-010-teamtailor-custom-fields.md` — decisión: EAV
    por owner con columnas tipadas (`custom_fields` catálogo +
    `candidate_custom_field_values` con `value_text/date/number/boolean`
    - `raw_value` siempre); sideload via `paginateWithIncluded`; orden
      `… → custom-fields → candidates → applications`.
  - Migrations 20260418154329..32: tablas nuevas + RLS + seed
    `sync_state` para `custom-fields`. Tipos DB regenerados.
  - `src/lib/teamtailor/paginate-with-included.ts` — async iterator
    que preserva `included` por página junto a cada recurso primario
    (5 unit tests).
  - `src/lib/teamtailor/client.ts` — método `paginateWithIncluded()`
    expuesto usando el mismo pipeline de retry/rate-limit.
  - `src/lib/sync/custom-fields.ts` + `customFieldsSyncer` registrado
    en `SYNCERS` entre `jobs` y `candidates`. 3 integration tests.
  - `src/lib/sync/run.ts` — `EntitySyncer.includesSideloads` flag;
    cuando está activa, el runner itera via `paginateWithIncluded` y
    pasa `included` a `mapResource(resource, included)`. Los 4
    syncers existentes siguen andando sin tocar (reciben `[]`).
  - `src/lib/sync/candidates.ts` — ahora emite
    `{ candidate, customFieldValues[] }`. En `upsert()` hace: (1)
    upsert de candidates con `.select()` para recuperar UUIDs locales,
    (2) lookup batched del catálogo, (3) cast `raw_value` → columna
    tipada según `field_type` (Text/Date/Number/Boolean; raw_value
    siempre preservado), (4) upsert idempotente por
    `teamtailor_value_id`. 2 integration tests.
  - **F1-011b** ✅ — `/candidates/[id]` renderiza la sección
    "Metadata VAIRIX" con los valores del candidato; display por
    `field_type` (Text/Date/Number/Boolean) con fallback a
    `raw_value`; badge "private" visible cuando el catálogo lo marca.
    Sección se oculta cuando no hay valores.
  - **NOTA**: full resync queda documentado pero **no corrido**. Validar
    mapeo con muestras de ~10 candidates antes de escalar.

- **F1-009e** ✅ done — 2026-04-18 — Playwright e2e smoke suite.
  - `playwright.config.ts` — `webServer` arranca `next dev` en
    puerto 3100 forzando `NEXT_PUBLIC_SUPABASE_*` al stack local
    aunque `.env.local` apunte a remoto. `workers: 1`,
    `fullyParallel: false`, `storageState` compartido.
  - `tests/e2e/seed.ts` — seed idempotente (`wipeE2EArtifacts` +
    `seedE2EFixtures`) que crea admin auth user, `app_users` admin,
    3 candidates (Alice/Bob/Carla), 1 job "Backend Engineer" y 1
    application activa (Alice→backend). Identificable por email
    `@e2e.test` y `teamtailor_id` prefijo `e2e-`. Corre también
    stand-alone con `pnpm test:e2e:seed`.
  - `tests/e2e/global-setup.ts` — mintea sesión admin sin round-trip
    browser: `admin.generateLink` → `email_otp` → `verifyOtp` con
    anon client → serializa la sesión con el mismo formato que
    `@supabase/ssr` (cookie `sb-127-auth-token`, prefijo `base64-`,
    base64url de JSON, chunking a 3180 chars) y escribe
    `playwright/.auth/admin.json` directo. Esto esquiva el hecho
    de que `generateLink` devuelve implicit-flow (hash tokens)
    mientras que el callback de la app es PKCE-only.
  - `tests/e2e/smoke.spec.ts` — 8 tests `@smoke`: home autenticado,
    empty state de candidates, query devuelve Alice, filtro status,
    click → profile, 404 en UUID inválido, logout, redirect a
    `/login` en no-autenticado. Todos verdes en ~13s.
  - Fix lateral: `src/app/login/login-form.tsx` tenía
    `useActionState` (React 19) pero el proyecto usa React 18.3;
    cambiado a `useFormState` desde `react-dom`.
  - Nuevo script `pnpm test:e2e:smoke` para correr la suite.

- **F1-005** ✅ done — 2026-04-17 — commits
  `5543446`/`fbe9c1e` (F1-005a: lock),
  `956bd17` (F1-005c: CLI), con F1-005b entre ambos
  (`test(sync): [RED] runIncremental...` + `feat(sync): [GREEN] runIncremental...`).
  - `src/lib/sync/`:
    - `errors.ts` — `SyncError`, `LockBusyError`, `UnknownEntityError`.
    - `lock.ts` — `acquireLock` con conditional UPDATE (no matchea
      si hay run activo dentro del stale window); `releaseLock`
      estampa `last_run_finished` + status, en 'error' NO avanza
      `last_synced_at`; `readSyncState` helper camelCase.
    - `run.ts` — `runIncremental` genérico + contrato
      `EntitySyncer` (buildInitialRequest / mapResource / upsert).
      Row error → `sync_errors`, batch continúa. Upsert falla
      o TT agota retries → release error + watermark pinned.
      Usa `last_run_started` como nuevo watermark al success.
    - `stages.ts` — primer syncer concreto: mapea
      `/stages` → tabla `stages` con `job_id = null` (la
      reconciliación con jobs viene en F1-006).
  - `src/scripts/sync-incremental.ts` — CLI entry point con
    exit codes distintos por escenario (0/1/2/3/4).
  - Tests: 10 nuevos integration tests contra Supabase local +
    MSW, cubren los 5 acceptance criteria de UC-05 (idempotency,
    stale lock reclaim, fatal preserves watermark, row error
    continues batch, upsert all pages).
  - Gotcha corregido: MSW `setupServer` por default bloquea
    TODOS los requests con `onUnhandledRequest: 'error'`;
    usamos un matcher custom para sólo bloquear calls al
    BASE_URL de Teamtailor y dejar pasar los de Supabase local.
  - Gotcha corregido: Postgres timestamptz vuelve como
    `+00:00` por PostgREST (no `.000Z`); las aserciones
    comparan por epoch ms.

- **F1-004** ✅ done — 2026-04-17 — commits
  `a4097e1`/`0a72be6` (F1-004a: errors/types/rate-limit/retry/parse),
  `0668b40`/`09b52a7` (F1-004b: client + paginate con MSW).
  - Módulos en `src/lib/teamtailor/`:
    - `errors.ts` — jerarquía `TeamtailorError` → `HttpError`,
      `RateLimitError`, `ParseError` con `context` opcional.
    - `types.ts` — tipos JSON:API (`TTJsonApiDocument`,
      `TTJsonApiResource`, `TTJsonApiLinks`) y parsed
      (`TTParsedDocument`, `TTParsedResource`). Attributes
      normalizadas shallow kebab→camel.
    - `rate-limit.ts` — `TokenBucket` con clock inyectable
      (`pendingWaitMs()` + `take()`; caller hace el sleep).
    - `retry.ts` — `defaultRetryPolicy()` (5 attempts, 1s→30s,
      jitter 50–100 %), `parseRetryAfter()` (segundos numéricos
      - RFC 7231), `shouldRetry()` y `computeBackoff()`.
    - `parse.ts` — `parseDocument()`/`parseResource()` con
      `ParseError` en shapes inválidas; coerce data single↔array.
    - `paginate.ts` — async iterator genérico que consume
      `links.next` y respeta break temprano del consumidor.
    - `client.ts` — `TeamtailorClient` compone todo:
      fetch (inyectable para MSW) + auth headers
      (`Authorization: Token token=<key>` / `X-Api-Version` /
      `Accept: application/vnd.api+json`) + bucket global +
      retry (429/5xx/network, honra Retry-After). Expone
      `get()` y `paginate()`.
  - Tests (vitest + msw/node): 52 unit tests en 6 suites,
    todos verdes en <1 s. Fixtures anonimizadas en
    `tests/fixtures/teamtailor/candidates-page-{1,2,3}.json`.
    Virtual clock (`now` + `sleep` inyectados) evita esperas
    reales en tests de retry/rate-limit.
  - Gotcha corregido: en el test de Retry-After el default
    jitter (50–100 %) hacía la aserción flaky; se usa jitter
    identidad en ese test para aserciones exactas.

- **F1-003** ✅ done — 2026-04-17 — commits
  `c851643`/`04789fa` (app_users), `36b97b0`/`8958273` + `036c934` (Wave 1),
  `cb08d1e`/`dbb324f` (Wave 2), `923e3d1`/`47f2bb2` (Wave 3),
  `20e7f3a`/`cbf5a92` (fixes al hook).
  - 17 tablas de dominio creadas con RLS enabled + forced. 4 policies
    por tabla (select/insert/update/delete) salvo sync_state y
    sync_errors (1 policy `for all` admin-only).
  - Helper `public.current_app_role()` (SECURITY DEFINER) resuelve rol
    desde `app_users` por `auth.uid()`. Divergencia explícita con
    ADR-003 §5 que proponía claim JWT; documentada en commit
    `04789fa`.
  - 24 migraciones (13 de schema + 11 de RLS).
  - 16 suites de tests RLS con 54 tests en total. `fileParallelism:
false` en `vitest.config.ts` — los tests comparten estado en la
    misma DB local y paralelizar causa race conditions en teardown.
  - Tipos TS regenerados al final de cada Wave.
  - Fixes colaterales del pre-commit hook:
    - `TDD_RED=1` permite saltear el paso de tests para commits
      `[RED]` intencionales (documentado en
      `.claude/skills/tdd-workflow/SKILL.md`).
    - Chequeo de "tipos regenerados" ahora acepta el caso de tipos
      ya al día en HEAD sin re-stagear (útil para commits
      secuenciales de migraciones en un batch); usa tempfile para
      evitar que `command substitution` corra los trailing newlines
      y rompa el diff.
  - Harness de RLS en `tests/rls/helpers.ts` firma JWT HS256 con
    `node:crypto` (sin dependencia externa).
  - Desvío del plan: `shortlist_candidates` se creó en Wave 2 junto
    con `shortlists` (el plan original lo listaba en Wave 3); el
    split natural es por dependencia del grafo (ambas tablas
    comparten FK a `app_users`).

- **F1-002** ✅ done — 2026-04-17 — commit `be7d1f9`
  - `supabase init` + stack local arriba (Postgres 15, pgvector 0.7.4,
    Studio en :54323, DB en :54322)
  - Migración `20260417201204_extensions_and_helpers.sql`:
    `uuid-ossp`, `vector`, `pg_trgm` + función `set_updated_at()`
  - `supabase db reset` aplica limpio; `supabase db diff` vacío
  - `src/types/database.ts` regenerado (scaffolding, sin tablas de
    dominio todavía)
  - Fixes colaterales del pre-commit hook:
    - Removida entrada `*.sql` de lint-staged (prettier sin parser SQL)
    - Agregado `--no-warn-ignored` al eslint de `*.{ts,tsx}` para que
      lint-staged no falle cuando toca archivos en `ignores`

- **F1-001** ✅ done — 2026-04-17 — commits `078f6f2`, `71b78bb`
  - `tsconfig.json` con `strict` + `noUncheckedIndexedAccess` + alias `@/`
  - `eslint.config.js` (flat config ESLint 9) + `@typescript-eslint`
    - `@next/eslint-plugin-next` con `no-explicit-any:error` y
      `consistent-type-imports:warn`. `no-undef:off` porque TS ya
      cubre globals (JSX, etc.)
  - `.prettierrc` (100 cols, singleQuote, trailingComma all) +
    `.prettierignore`
  - Skeleton App Router: `src/app/layout.tsx` + `src/app/page.tsx`,
    `next-env.d.ts`. `package.json` con `"type": "module"` para
    ESLint ESM
  - Fix colateral: el hook `.claude/hooks/pre-commit.sh` llamaba
    `pnpm test --run` y pnpm 9 interpretaba `run` como subcomando.
    Reemplazado por `pnpm exec vitest run`
  - `pnpm format` corrió contra todo el repo (commit separado
    `71b78bb` de solo reformato — 41 archivos docs/config)
  - DoD: `pnpm install` limpio, `pnpm typecheck` verde,
    `pnpm lint` verde

- **infra/chronicle-mcp** ✅ done — 2026-04-17 — commit `5953276`
  - `~/.chronicle/config.json` creado (userId=gabo,
    dbPath=$HOME/.chronicle/chronicle.db)
  - Entrada `chronicle` agregada en `.mcp.json` (mcpServers +
    tooling_boundaries), JSON validado con `jq`
  - Pre-descarga de `chronicle-mcp` vía `npx` OK
  - ADR-008 creado
  - **Etapa 3** ✅ seed de 15 items: 10 memorias Core
    (7 architectural ADR-001..007 + 3 procedural: rate limit TT,
    chmod post-unzip, regen tipos post-migración), 2 Working
    (semantic: quirk macOS Finder dotfiles, ausencia sandbox TT),
    3 preferences (pnpm, Conventional Commits, TS estricto)
  - **Etapa 4** ✅ 3 triggers activos: `backfill` (warning/T2),
    `drop-table` (critical/T3), `deploy` (warning/checklist
    pre-merge)
  - **Etapa 5** ✅ validación: `stats` = 12 mem + 3 prefs,
    `recall "RLS y roles"` devuelve ADR-001/002/003, los 3 `check`
    disparan OK
  - Railway sync **NO activado** (Fase 1 → requiere ADR dedicado)
  - Desvío del runbook: `docs/scaffolding-inventory.md` no existe
    en el repo; el step 7.1 se saltea y se documenta acá en lugar
    de crear el archivo out-of-scope
  - Quirk menor: `hostname` en macOS devolvió la IP local
    (192.168.1.8) como `deviceId`. No bloqueante; editable en
    caliente en `~/.chronicle/config.json`
  - Quirk Chronicle: las 2 memorias `semantic` quedaron en tier
    `working` en lugar de `buffer` (Chronicle auto-tiera por
    tipo/confirmación; no expone parámetro de tier explícito).
    No bloqueante

---

## 🏃 En progreso

_(nada todavía)_

---

## ⏳ Próximo (top 3 del roadmap)

1. **F4-006** — Job query decomposition (`DecompositionProvider` +
   `OpenAiDecompositionProvider`, `gpt-4o-mini`, persist a
   `job_queries` con `decomposed_json` inmutable + `resolved_json`
   mutable, ADR-014).
2. **F4-007** — Variant merger + years calculator + ranker
   determinístico (ADR-015, depende F4-005 + F4-006).
3. **F4-007bis** — `candidate_experiences.description_tsv` migración
   aditiva (ADR-016 §3, habilita FTS en evidence panel).

Ver `docs/roadmap.md` para el plan completo de F4-001..F4-009 con
prompts listos.

---

## 🚫 Bloqueos

- ✅ **F4-008 Gate estructural resuelto — opción B (ADR-017)** —
  2026-04-21. Usuario aprueba abrir `match_results INSERT` al
  recruiter dueño del parent `match_run`. ADR-017
  (`docs/adr/adr-017-match-results-insert-ownership.md`) + migración
  `20260421000001_rls_match_results_insert_own_run.sql` (`93089a9`)
  reemplazan `match_results_admin_insert` por
  `match_results_insert_own_run_or_admin`. Inmutabilidad post-insert
  preservada (no existe policy UPDATE + trigger
  `enforce_match_results_insert_only` bloquea UPDATE incluso con
  service role). CLAUDE.md #4 intacto. 23 tests RLS verde. F4-008
  desbloqueado.
- ⏳ **Lista de custom fields de Teamtailor** (pendiente de acceso).
- ⏳ **Tenant de staging en Teamtailor** (no existe, hay que crear).
- ✅ **Verificar `X-Api-Version` vigente** — resuelto 2026-04-17:
  la vigente es `20240904` (la API la revela con HTTP 406 si falta
  el header). `.env.example` actualizado.

---

## ⚠️ Drift detectado entre docs

_(lista de inconsistencias encontradas y su plan de resolución)_

- ADR-002 lista orden de sync `jobs → candidates → …`; ADR-004 y
  `spec.md` dicen `stages → users → jobs → …`.
  **Plan**: actualizar ADR-002 con nota "orden actualizado en
  ADR-004" (pendiente F1-000).

---

## 📊 Health checks

- [x] `pnpm typecheck` — verde (2026-04-17)
- [x] `pnpm lint` — verde (2026-04-17)
- [x] `pnpm test` — 116/116 verde (2026-04-17), ~10s end-to-end
      (54 RLS + 52 unit de `src/lib/teamtailor` + 10 integration
      de `src/lib/sync`)
- [ ] Coverage global ≥ 80% — _(no medido formalmente todavía;
      teamtailor/ y sync/ con cobertura representativa por tests)_

---

## 📘 Cambios recientes de docs/infra

- **2026-04-17** — ADR-003 §7 agregado: nueva nomenclatura de API
  keys de Supabase (modelo 2025+). Env vars renombrados:
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY`. Actualizados:
  `.env.example`, `scripts/bootstrap.sh`, `.claude/hooks/pre-commit.sh`
  (+ guardrail sobre prefijo `sb_secret_`),
  `.claude/agents/security-reviewer.md`,
  `.claude/skills/rls-policies/SKILL.md`,
  `docs/runbooks/initial-backfill.md`. Seed Chronicle como memoria
  semantic (Core).

---

## 🔐 Deuda de seguridad (acotada, con plazo)

- **🔄 Rotar `TEAMTAILOR_API_TOKEN` a least-privilege antes del
  primer backfill real (F1-004)**.
  - **Estado actual**: clave "Dev" con alcance **Administrador + Leer/Escribir**.
  - **Objetivo**: clave nueva `recruitment-platform-etl-ro` con
    alcance **Administrador + Leer** (sin Escribir). El ETL es
    read-only por ADR-002.
  - **Cuándo**: antes de habilitar `DRY_RUN=false` en el primer
    sync contra tenant productivo (F1-004, pre-flight del runbook
    `docs/runbooks/initial-backfill.md`).
  - **Cómo**: Teamtailor admin → Integraciones → Claves API →
    Nueva clave API → Alcance=Administrador, Leer=✓, Escribir=✗ →
    actualizar `.env.local` + secrets de Supabase Edge + secrets de
    GitHub Actions → smoke test → revocar la "Dev".

- **🔄 Rotar `SUPABASE_SECRET_KEY` antes de Fase 2 / staging**.
  - **Estado actual**: valor `sb_secret_0BfS...` compartido por
    chat durante el setup del 2026-04-17.
  - **Cuándo**: antes de cualquier ambiente no-dev. Ver ADR-003 §7
    sobre el modelo nuevo de keys rotables.

- **🔄 Rotar `OPENAI_API_KEY` antes de Fase 2 / staging**.
  - **Estado actual**: key project-scoped `sk-proj-Zp1N...`
    compartida por chat durante el setup del 2026-04-17.
  - **Cuándo**: antes de cualquier ambiente no-dev. Al rotar, usar
    el límite de gasto (usage limit) del proyecto de OpenAI para
    acotar blast radius.

- **🔄 Decidir data retention de OpenAI para F4 antes del primer
  backfill de extracción contra prod**.
  - **Estado actual**: key project-scoped estándar, retention on
    (hasta 30d para abuse monitoring de OpenAI). Decisión del
    usuario (2026-04-20) aceptó este riesgo explícitamente para
    arrancar F4.
  - **Por qué es deuda**: F4 (ADR-012 propuesto) manda CVs
    completos de candidatos — con PII (nombre, email, teléfono,
    LinkedIn, historial laboral) — a OpenAI. La política estándar
    acepta que esos payloads queden hasta 30d en storage de abuse
    monitoring de OpenAI.
  - **Gate de desbloqueo antes de F4 contra tenant productivo**
    (no antes del desarrollo sobre fixtures locales):
    1. Verificar en el admin de OpenAI si la cuenta permite
       zero-retention (requiere Enterprise o Zero Data Retention
       agreement).
    2. Si sí → habilitar y rotar key.
    3. Si no → mantener el riesgo aceptado documentado en ADR-012
       §Riesgos. Escalarlo con producto/legal si existe interés
       de VAIRIX de cumplir con compliance formal en Fase 2+.
  - **Alternativa si compliance lo requiere**: Anthropic Claude
    (retention off by default). Queda listada en ADR-012
    §Alternativas descartadas como plan B con trigger explícito.

---

## 🔗 Notas volátiles

_(cosas que se van descubriendo y hay que validar — no arquitectura
formal, solo memoria de trabajo)_

- Revisar si `text-embedding-3-small` sigue siendo el último
  modelo "small" al momento de F3-001.
- Al arrancar F1-004, confirmar rate limit real contra tenant de
  prueba (la doc dice ~50 req/10s; verificar).
- **[2026-04-18] Auditoría de muestra (900 candidates, 1 job, 10
  stages/users) sobre tenant productivo**: el syncer actual NO usa
  `?include=...` en las llamadas a TT. `raw_data.relationships`
  trae sólo links (`self`/`related`) pero no los recursos sideloaded.
  Consecuencia: `custom-field-values`, `form-answers`, `uploads`
  (CVs), `interviews`, `answers`, `questions` quedan sin persistir.
  Antes de full sync hay que:
  1. Listar los custom fields del tenant (`/custom-fields`) y
     decidir cuáles mapear a columnas vs dejar en `raw_data`.
  2. Decidir si los adjuntos de `uploads` se descargan al bucket
     `candidate-cvs` como parte del ETL o vía worker separado.
  3. Definir cómo entran los formularios de entrevista técnica que
     hoy viven en Google Docs (ADR nuevo: integración con Drive).
  4. Extender syncers con `include` params + sideload handling en
     `client.paginate` si aún no lo soporta.
- **Full sync DIFERIDO**: no correr `pnpm sync:full` hasta validar
  puntos 1–4 de arriba. Usar muestras capeadas vía cap temporal o
  `page[size]` bajo mientras se audita.

---

## Convención de entradas

Al cerrar una sesión, agregar una entrada en la sección correcta:

```
- **F1-003** ✅ done — 2026-04-18 — commit abc123
  - aplicadas 13 migraciones
  - 42 tests RLS verdes
  - tipos regenerados
  - nota: agregado índice extra sobre `evaluations.needs_review`
    que no estaba en data-model.md → PR al doc pendiente
```

Si quedó algo abierto, anotarlo explícitamente:

```
- **F1-005** 🏃 in progress — 2026-04-18 — commit def456
  - lock + stale timeout implementados
  - falta: tests de race condition entre dos runs
  - bloqueado por: decisión sobre advisory locks vs lock column
```
