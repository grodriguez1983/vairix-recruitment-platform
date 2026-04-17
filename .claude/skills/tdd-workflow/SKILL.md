---
name: tdd-workflow
description: Cómo practicar TDD dentro de una sesión agente sin caer en phase-collapse. Commits [RED]/[GREEN] como gate estructural, tests adversariales contra interfaces, prevención de tests vacíos post-hoc. Usar cuando la tarea implique escribir código nuevo de lógica de dominio (parsers, normalizadores, services, ETL mappers).
---

# TDD Workflow

## Por qué este skill existe

Paper GS §4.3 describe el **phase-collapse**: en un agente de IA,
el que escribe el test y el que escribe el código viven en el
mismo contexto. No hay separación temporal, entonces la presión
del "test que falla" se pierde.

Este skill es el gate estructural que evita ese colapso.

## Cuándo aplicar este skill

- Implementar lógica pura no trivial (parsers, validators,
  matchers, transformers, mappers).
- Arreglar un bug (primero reproducirlo con un test que falla).
- Refactorear un módulo con lógica compleja.

**No aplica a**: setup de infra, ajustes de config, UI sin lógica,
CSS, cambios tipográficos.

## Flujo obligatorio — RED → GREEN → REFACTOR

### Paso 1 — RED

1. Escribir el test que describe el comportamiento esperado.
2. El test **debe fallar** por la razón correcta (la función no
   existe, o el comportamiento aún no está).
3. Correr el test y **copiar el output en el commit message**.
4. Commit:

```
test(parser): [RED] rejects PDF with empty text

Expected: parseCv returns { parse_error: 'empty_text' }
Actual: TypeError: parseCv is not a function

Output:
  FAIL  src/lib/cv/parser.test.ts > rejects PDF with empty text
    TypeError: parseCv is not a function
     at .../parser.test.ts:12:3
```

**Regla estructural**: sin el `[RED]` en el subject, el hook de
commit-msg lo rechaza. El output pegado es evidencia de que el
test realmente falla.

### Paso 2 — GREEN

1. Escribir la implementación **mínima** que hace pasar el test.
2. No agregar features no pedidas por el test.
3. Correr **toda la suite**, no solo el test nuevo.
4. Commit:

```
feat(parser): [GREEN] handle empty-text PDFs

Minimal implementation: returns parse_error='empty_text' when
extracted text is shorter than MIN_USEFUL_TEXT.

Closes RED commit abc1234.
```

**Regla estructural**: el pre-commit hook valida que haya un commit
`test: [RED]` previo con scope coincidente (`parser` en este caso)
en los últimos N commits del branch. Si no, rechaza.

### Paso 3 — REFACTOR (opcional pero recomendado)

1. Limpieza: mejor naming, extraer funciones, simplificar.
2. Tests siguen verdes.
3. Commit:

```
refactor(parser): extract normalizeWhitespace helper
```

## Escribir tests adversariales

El test es un **cazador**, no un testigo (paper §4.3 *Verifiable*).

### Preguntas previas al test

Antes de escribir cada test, responder (aunque sea mentalmente):

1. ¿Qué input rompería mi implementación?
2. ¿Qué violación de contrato debería ser imposible?
3. ¿Qué pasa con inputs vacíos, huge, unicode, null?
4. ¿Qué transiciones de estado no deberían existir?

### Naming

```
// ✅ Buenos nombres (nombran la violación)
test_rejects_content_hash_mismatch
test_denies_cross_tenant_access
test_refuses_oversized_file
test_stops_retrying_after_max_attempts

// ❌ Malos nombres (solo documentan el happy path)
test_parser_works
test_basic_flow
test_returns_correct_value
```

### Contra interfaces, no contra implementación

```typescript
// ❌ MAL — acoplado a internals
test('_hash calls createHash once', () => {
  const spy = vi.spyOn(crypto, 'createHash');
  parser._hash('foo');
  expect(spy).toHaveBeenCalledOnce();
});

// ✅ BIEN — verifica comportamiento observable
test('returns same hash for equivalent input', () => {
  expect(parser.hash('  foo  ')).toBe(parser.hash('foo'));
});
```

**Regla**: si el test verifica cómo, no qué, probablemente lo estás
haciendo mal.

## Tests vacíos / post-hoc (qué detecta el hook)

El pre-commit hook rechaza:

- Commit `feat:` sin `test: [RED]` previo en el mismo scope.
- Commit que solo agrega tests donde TODOS pasan al primer run
  (signal de test post-hoc).
- Tests con solo `expect(x).toBeDefined()` o
  `expect(true).toBe(true)`.
- Archivos `.test.ts` con `skip` / `only` / `todo`.

## Excepciones legítimas

No todo merece TDD estricto:

- **Cambios puramente visuales** (CSS, copy). Hacer tests visuales
  de aceptación en E2E.
- **Config y setup** (Next config, eslint, tsconfig).
- **Migrations** (cambios de schema). Los tests RLS los cubren.
- **Fixes triviales** (typo en mensaje de error). OK skipear RED
  → directo GREEN con justificación en commit body.

Si skipeás, documentarlo:

```
feat(ui): fix typo in empty state message [tdd-skip: trivial]
```

El hook conoce la flag `[tdd-skip: <razon>]`. Abusarla activa
review manual.

## Cobertura como gate

- Global 80%, `src/lib/` 90%, `src/lib/auth/` 95% (ver
  `docs/test-architecture.md` §8).
- CI falla si baja.
- No se puede usar `/* istanbul ignore */` sin comment explicando
  por qué. El hook valida el comment.

## Checklist por feature nueva

- [ ] Commit `test: [RED]` con test que falla por razón correcta.
- [ ] Output del test pegado en commit body.
- [ ] Commit `feat: [GREEN]` con implementación mínima.
- [ ] Toda la suite pasa tras GREEN.
- [ ] Al menos un test adversarial (rejects/denies).
- [ ] Cobertura del scope ≥ 90%.
- [ ] Tests contra interfaz pública, no internals.

## Referencias

- Paper GS §4.3 *Verifiable* y *Defended: Process* — fundamento
  del phase-collapse.
- `docs/test-architecture.md` — pirámide y coverage.
- `.claude/hooks/pre-commit.sh` — hook que valida.
- `.claude/hooks/commit-msg.sh` — hook que valida `[RED]/[GREEN]`.
