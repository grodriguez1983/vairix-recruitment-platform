# ADR-011 — Server-rendered search pages (form GET + direct service call)

- **Estado**: Aceptado
- **Fecha**: 2026-04-19
- **Decisores**: Gabo
- **Relacionado con**: spec.md §6 (UC-01, UC-02), ADR-003 (RLS),
  ADR-005 (embeddings), F3-002, F3-003,
  `src/app/(app)/search/semantic/page.tsx`,
  `src/app/(app)/search/hybrid/page.tsx`,
  `src/lib/search/hydrate.ts`

---

## Contexto

Las páginas `/search/semantic` (F3-002) y `/search/hybrid` (F3-003)
son la UI para los casos de uso UC-01 (recruiter busca candidatos con
filtros + query) y UC-02 (búsqueda semántica pura). Son herramientas
internas de 5–15 usuarios, sin concurrencia relevante, y necesitan:

- Resultados **RLS-scoped** (un recruiter nunca ve un candidato al que
  no tiene acceso).
- URLs **compartibles** (un recruiter pega una búsqueda en Slack y
  el colega reproduce el mismo resultado).
- Cero estado cliente que sobreviva al refresh.
- Latencia aceptable con el proveedor de embeddings lazy (OpenAI):
  resolver el provider solo si la query lo requiere.

Ya existía `/api/search/semantic` (route handler), pero la página no
lo usa. La pregunta era: ¿la página hace `fetch('/api/...')` desde
el server, o llama al servicio en proceso?

---

## Decisión

Las páginas de búsqueda siguen el patrón **form GET + server render +
service call directo**:

1. **Form method=GET**. Los filtros y la query viven en la URL
   (`?q=...&status=...&job_id=...`). El submit hace una navegación
   full-page, no un fetch AJAX. La URL es la fuente de verdad.

2. **Server component async** como handler. El page lee
   `searchParams` (validado con parsers inline), llama
   `requireAuth()`, y renderiza.

3. **Servicio invocado en proceso**, no vía HTTP. La página importa
   `semanticSearchCandidates` / `hybridSearchCandidates` y los
   ejecuta con el cliente Supabase server-side (`createClient()`),
   que propaga el JWT del usuario → RLS aplica.

4. **Proveedor de embeddings lazy**. Se resuelve solo cuando hay
   query. En modo "solo filtros estructurados" se pasa un stub
   sintético que lanza si se llama; `hybridSearchCandidates` no lo
   invoca en ese modo. Mantiene el código path único y evita
   importar OpenAI en requests que no lo necesitan.

5. **Hidratación via `hydrateCandidatesByIds`**. El servicio de
   búsqueda devuelve ids + scores; `hydrateCandidatesByIds` levanta
   los campos de card (nombre, email, pitch, linkedin) con el mismo
   cliente RLS-scoped y **preserva el orden de ids** del caller.
   Las filas que RLS oculta desaparecen silenciosamente.

6. **Errores de proveedor** (OpenAI 429/timeout) se atrapan y
   renderizan un banner in-page — no redirect, no 500. La
   búsqueda estructurada sin query sigue andando aunque OpenAI
   esté caído.

El route handler `/api/search/semantic` se mantiene para clientes
externos (CLI, scripts, e2e) pero la UI no lo usa.

---

## Alternativas consideradas

### A) Server component llama vía `fetch('/api/search/...')`

- **Pros**: una sola implementación del endpoint; separación
  clara UI/API.
- **Contras**: hop HTTP innecesario (server → mismo server), dos
  copias de auth (cookie re-read + JWT propagation), más latencia,
  y la API route obliga a serializar/deserializar el match.
- **Descartada porque**: no hay cliente externo que justifique el
  hop. El route handler existe y se mantiene, pero llamarlo desde
  el server component es overhead sin beneficio.

### B) Client component con SWR / React Query

- **Pros**: UX más fluida (loading skeletons, optimistic).
- **Contras**: estado duplicado (URL vs React state), sharing
  complicado (serializar filtros en URL igual), bundle size, y
  un RSC con `searchParams` cumple el caso de uso.
- **Descartada porque**: la herramienta es interna, 5–15 users,
  sin SLA de UX. Simpler wins.

### C) Server action (POST + redirect to GET)

- **Pros**: payloads grandes no caben en URL; validación nativa de
  form actions.
- **Contras**: el caso real es `?q=...` (< 200 chars) y los filtros
  son enums / UUIDs. POST+redirect agrega un round-trip sin
  beneficio.
- **Postergada**: si aparecen filtros complejos (array de skills,
  rangos múltiples), reevaluar.

---

## Consecuencias

### Positivas

- URL compartible out of the box; no hay que construir estado
  cliente.
- RLS se aplica automáticamente: misma pasada de cliente Supabase
  que el resto de las páginas. No hay service-role en paths de
  usuario.
- Proveedor OpenAI no se importa ni instancia si no hay query → la
  búsqueda estructurada pura no depende de que OpenAI esté up.
- Menos superficie que testear: el servicio y el hidratador ya
  tienen cobertura de integración; la página es composición.

### Negativas

- La página no es testeable aislada sin mockear `requireAuth` y
  `next/navigation`. Hoy la cobertura viene por composición
  (servicio + hidratador + parsers puros unit-tested +
  structured-search tests). Si la lógica de la página crece más
  allá de "parse + llamar servicio + renderizar", habrá que
  refactorizar para testabilidad directa.
- Cada submit es una navegación full-page. Aceptable para 5–15
  users; no aceptable para un caso de público general.

---

## Criterios de reevaluación

Esta decisión vuelve a la mesa si:

- Aparecen filtros con estado complejo (multi-select con autocompletado,
  rangos encadenados) que no se representan razonablemente en URL
  → considerar server action o client component con URL sync.
- La herramienta deja de ser interna (>50 usuarios, SLA de UX) →
  pasar a client component con streaming/SSR selectivo.
- Aparece un tercer caller del endpoint (más allá de la UI y el
  hipotético CLI) → revaluar mover la lógica de la página a la
  API route y llamar desde allí.
- Se agrega un segundo proveedor de embeddings con latencias
  materialmente diferentes → considerar cache de queries en la URL
  o server-side memoization.

---

## Notas de implementación

- Los parsers (`parseQuery`, `parseStatus`, `parseUuid`,
  `parseDateInputToIso`, `firstOf`) viven en
  `src/lib/search/search-params.ts` — compartidos por ambas pages
  y unit-tested (`search-params.test.ts`, 27 tests adversariales).
  Son deliberadamente permisivos: input inválido vuelve `null` en
  lugar de 400, y la UI trata `null` como "sin filtro". Esto mantiene
  las URLs compartibles aunque se editen a mano — no se rompe si
  alguien deja un `status=foo` viejo en la URL.
- `hydrateCandidatesByIds` preserva el orden de ids recibidos; el
  ranking viene del servicio. Cambiar ese contrato rompería la
  semántica de relevancia en la UI. Cubierto por
  `tests/integration/search/hydrate.test.ts`.
- El stub de provider que se pasa en modo structured-only lanza si
  `embed()` se llama. Actúa como tripwire: si un refactor futuro
  llama embed sin query, el test explota. Si ese comportamiento
  cambia (ej. embed por defecto para exploración), actualizar
  ADR-005.
