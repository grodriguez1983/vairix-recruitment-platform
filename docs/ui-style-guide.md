# 🎨 UI Style Guide — Recruitment Data Platform

> Guía de estilos del producto. Deriva del **Kit de Marca de VAIRIX**
> (empresa matriz) y lo adapta al contexto de una herramienta interna
> de datos. Cualquier decisión visual del producto debe respetar esta
> guía, y cualquier desvío debe documentarse como ADR.

---

## 1. Relación con la marca matriz

Este producto es un **tool interno de VAIRIX**, no un producto
público con identidad propia. Por lo tanto:

- **Usa la paleta, tipografía y formas de VAIRIX** sin introducir
  colores o tipografías nuevas.
- **No usa el logo de VAIRIX como logo del producto**. El producto se
  identifica internamente por su nombre (`Recruitment Data Platform`
  o el nombre comercial interno que se le asigne).
- El isotipo de VAIRIX puede aparecer en footer, login y áreas
  secundarias, como firma de pertenencia.
- El lenguaje visual se inclina más hacia lo **funcional y denso en
  datos** que hacia lo **expresivo de marketing**. Los gradientes y
  formas expresivas de la marca se usan con moderación.

---

## 2. Modo Dark y Light

VAIRIX define ambos modos. Este producto:

- **Default: Dark mode**. La interfaz se usa durante jornadas largas
  leyendo evaluaciones y CVs; el dark reduce fatiga visual.
- **Light mode obligatorio** para impresión, exportaciones y
  shortlists compartidas.
- El usuario puede togglear. Persistir preferencia en perfil.

---

## 3. Paleta de colores

### Dark mode (default)

| Rol                | Nombre     | Hex       | Uso                             |
| ------------------ | ---------- | --------- | ------------------------------- |
| `bg`               | Ink Black  | `#071013` | Fondo principal                 |
| `surface`          | —          | `#0F1A1F` | Cards, panels (derivado del bg) |
| `border`           | Blue Slate | `#5E6472` | Bordes, dividers                |
| `text-primary`     | Platinum   | `#EBEBEB` | Texto principal                 |
| `text-muted`       | —          | `#9AA0A6` | Texto secundario, meta          |
| `accent-primary`   | Turquoise  | `#73D4B0` | Acciones primarias, success     |
| `accent-secondary` | Periwinkle | `#D8C7FA` | Highlights, tags, hover         |

### Light mode

| Rol                | Nombre          | Hex       | Uso                         |
| ------------------ | --------------- | --------- | --------------------------- |
| `bg`               | Bright Snow     | `#F8F7F9` | Fondo principal             |
| `surface`          | —               | `#FFFFFF` | Cards, panels               |
| `border`           | Dim Gray        | `#6E6A6F` | Bordes, dividers            |
| `text-primary`     | Ink Black       | `#071013` | Texto principal             |
| `text-muted`       | —               | `#6E6A6F` | Texto secundario, meta      |
| `accent-primary`   | Mint Leaf       | `#39B98A` | Acciones primarias, success |
| `accent-secondary` | Soft Periwinkle | `#AF8BF5` | Highlights, tags, hover     |

### Colores semánticos (extensión propia del producto)

VAIRIX no define estados de error/warning/info. Los agregamos
manteniendo armonía con la paleta:

| Rol       | Dark      | Light     | Uso                           |
| --------- | --------- | --------- | ----------------------------- |
| `danger`  | `#F28B82` | `#D93025` | Rechazo, destructive actions  |
| `warning` | `#FBBC04` | `#B06000` | Sync en riesgo, alertas leves |
| `info`    | `#8AB4F8` | `#1967D2` | Informativo, neutro           |

> ⚠️ Los semánticos **no** son parte de la marca VAIRIX y solo deben
> usarse para estados funcionales (no para decoración).

---

## 4. Reglas de uso de color

Heredadas del kit de marca VAIRIX:

✅ **Usar paletas mixtas** (base + acento, nunca solo acento).
✅ **Fondos neutros** (negro, blanco, grises). Nunca fondo acento en
grandes extensiones.
✅ **Paleta según fondo**: fondo claro → Light palette; fondo oscuro
→ Dark palette.

❌ **Nunca**:

- Acento sobre acento (turquesa sobre lila, o viceversa)
- Acento como fondo pleno en layouts grandes
- Mezclar mint leaf (light) con periwinkle (dark) en el mismo
  componente
- Gradiente **verde → lila en web** (genera bandas artefactuales)

---

## 5. Gradientes

Solo en títulos hero, fondos decorativos y estados especiales (onboarding).

- **Gradientes en fondo**: únicamente entre colores **base** del modo
  correspondiente.
- **Gradientes en texto**: de color base a color de acento.
- **Fondos con gradiente**: siempre sobre grises/negros/blancos,
  nunca sobre acentos.
- **Prohibido en web**: gradiente `turquoise → periwinkle` directo.
  Si hace falta combinar, mediar con un color neutro.

Uso recomendado en este producto:

- Título del dashboard principal.
- Header del perfil de candidate.
- Estado vacío inicial del talent pool.

---

## 6. Tipografía

Heredada directamente de VAIRIX.

- **DM Sans** → títulos, CTAs, números grandes (KPIs).
- **Inter** → cuerpo de texto, labels de forms, tablas, metadata.

### Reglas (del kit de marca)

- **Diferencia de 2 pasos** mínimo entre título y body para distinción.
- Títulos con:
  - `line-height: 100%`
  - `letter-spacing: -5%` (equivale a `-0.05em` en CSS)
- Títulos con **máximo 2 variaciones de peso**.
- Una frase única suelta se considera título.

### Escala tipográfica sugerida

Aplicando la regla de los 2 pasos:

| Rol     | Font             | Size            | Weight | Line height | Letter spacing |
| ------- | ---------------- | --------------- | ------ | ----------- | -------------- |
| Display | DM Sans          | 48px / 3rem     | 600    | 100%        | -0.05em        |
| H1      | DM Sans          | 36px / 2.25rem  | 600    | 100%        | -0.05em        |
| H2      | DM Sans          | 28px / 1.75rem  | 500    | 100%        | -0.05em        |
| H3      | DM Sans          | 22px / 1.375rem | 500    | 110%        | -0.03em        |
| Body L  | Inter            | 16px / 1rem     | 400    | 150%        | 0              |
| Body    | Inter            | 14px / 0.875rem | 400    | 150%        | 0              |
| Caption | Inter            | 12px / 0.75rem  | 400    | 140%        | 0              |
| Mono    | JetBrains Mono\* | 13px            | 400    | 140%        | 0              |

\*Mono solo para IDs, hashes, snippets de código. No es parte del
kit de marca pero es funcional para una app de datos. Aceptado como
extensión.

### Pesos disponibles

- DM Sans: Regular (400), Medium (500), SemiBold (600)
- Inter: Regular (400), Medium (500), SemiBold (600)

No usar Bold (700) ni Black (900) — rompen la jerarquía propuesta.

---

## 7. Formas y elementos visuales

Del kit de marca:

> _"Buscamos agregar redondez a los elementos, siempre destacando
> solo una de las esquinas más que el resto."_

### Radios de borde

| Token         | Valor      | Uso                             |
| ------------- | ---------- | ------------------------------- |
| `radius-sm`   | 6px        | Inputs, chips, tags             |
| `radius-md`   | 12px       | Botones, badges                 |
| `radius-lg`   | 20px       | Cards estándar                  |
| `radius-xl`   | 32px       | Hero cards, modals grandes      |
| `radius-hero` | asimétrico | Uno de los 4 corners más grande |

### Corner asimétrico (patrón de marca)

Para **cards destacadas**, **avatares de candidate** y **CTAs
principales**: uno de los 4 corners significativamente más grande
que los otros tres.

Ejemplo para una card de candidate destacado:

```css
border-radius: 20px 20px 20px 64px;
```

**Reglas**:

- Solo un corner exagerado por elemento.
- Mantener consistencia: mismo corner exagerado en elementos del
  mismo tipo dentro de una vista.
- No abusar: aplicar solo a elementos **destacados**, no a toda
  la UI.

### El elemento "flecha" (del isotipo)

El isotipo de VAIRIX tiene un elemento de flecha que el kit de marca
invita a reutilizar para dinamismo. En este producto:

✅ **Usos apropiados**:

- Botón "Next" en wizards multi-step.
- Indicador de dirección en breadcrumbs.
- Decoración en empty states ("empezá una búsqueda →").
- Marker en timelines del historial de candidate.

❌ **No usar** como:

- Bullet point genérico.
- Separador en navs densos.
- Decoración arbitraria sin función.

---

## 8. Componentes (reglas específicas del producto)

### Botones

| Variante    | Cuándo                                | Estilo                            |
| ----------- | ------------------------------------- | --------------------------------- |
| Primary     | Acción principal por pantalla (máx 1) | Fondo acento primario, texto base |
| Secondary   | Acciones secundarias                  | Outline con border en acento      |
| Ghost       | Acciones terciarias                   | Solo texto, sin fondo             |
| Destructive | Eliminar, rechazar                    | Fondo `danger`, texto claro       |

- Radio: `radius-md` (12px).
- Padding: 10px 20px (sm), 12px 24px (md), 16px 32px (lg).
- Iconos siempre a la izquierda del texto, salvo "Next" (→ derecha).
- Hover: elevar con sombra sutil + oscurecer/aclarar 4%.

### Inputs y forms

- Radio: `radius-sm` (6px).
- Border: 1px `border` color. Focus: 2px `accent-primary`.
- Placeholder en `text-muted`.
- Labels siempre arriba del input, nunca floating.
- Errores: mensaje debajo del input, color `danger`, con ícono.

### Cards de candidate

Componente más importante del producto. Reglas:

- Fondo `surface`, 1px border `border`.
- Radio: `radius-lg` (20px), con **corner inferior-izquierdo exagerado**
  (`radius-hero`) cuando el candidate está en shortlist o marcado.
- Contenido jerárquico:
  1. Foto/avatar (circular, 48px)
  2. Nombre (H3, DM Sans)
  3. Headline / última posición (Body, Inter, muted)
  4. Tags (chips con `radius-sm`)
  5. Meta: última actividad, fuente (Caption)
- Hover: border pasa a `accent-primary` + elevación de 2px.

### Tablas de datos

Uso principal: listas largas de candidates, applications, sync logs.

- Fila alterna con `surface` ligeramente distinto (2% de diferencia).
- Header sticky, `text-muted`, uppercase caption-size, letter-spacing
  `+0.05em`.
- Hover de fila: fondo `accent-secondary` con alpha 8%.
- Sin bordes verticales internos. Border horizontal sutil entre filas.

### Tags / Chips

- Tipos: `skill` (default), `seniority`, `behavior`, `manual`.
- Radio: `radius-sm`.
- Padding: 4px 10px.
- Color según tipo (convención a mantener consistente):
  - `skill` → fondo `accent-secondary` suave + texto primary
  - `seniority` → outline neutral
  - `manual` → fondo `accent-primary` suave + texto primary
- Tamaño: Caption (12px).

### Modales y drawers

- Drawer lateral para perfil de candidate (más usado que modal).
- Radio: `radius-lg` en corner opuesto al lado de aparición.
- Backdrop: negro con alpha 60%.
- Ancho drawer: 480px desktop, full-screen mobile.

---

## 9. Layout y espaciado

### Escala de espaciado (múltiplos de 4)

```
4, 8, 12, 16, 24, 32, 48, 64, 96
```

Tokens Tailwind: `1, 2, 3, 4, 6, 8, 12, 16, 24`.

### Grid base

- **Desktop**: 12 columnas, gutter 24px, max-width 1440px.
- **Tablet**: 8 columnas, gutter 16px.
- **Mobile**: 4 columnas, gutter 16px.

### Densidad de UI

Este es un producto **data-dense**. Preferir densidad media-alta sobre
aire excesivo:

- Padding en cards: 20px (no 32px).
- Row height en tablas: 48px (no 64px).
- Gap entre elementos en listas: 8px–12px.

---

## 10. Iconografía

- Librería: **Lucide** (consistente con shadcn/ui y estéticamente
  alineada con DM Sans).
- Tamaño default: 20px. Secundarios: 16px. Hero: 32px.
- Stroke width: 1.75 (entre el default 2 y el thin 1.5).
- Color: hereda del texto del contexto; nunca colorear íconos con
  accent salvo en CTAs o estados específicos.

---

## 11. Implementación técnica

### Design tokens como CSS variables

```css
:root {
  /* Radios */
  --radius-sm: 6px;
  --radius-md: 12px;
  --radius-lg: 20px;
  --radius-xl: 32px;

  /* Tipografía */
  --font-display: 'DM Sans', system-ui, sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

[data-theme='dark'] {
  --color-bg: #071013;
  --color-surface: #0f1a1f;
  --color-border: #5e6472;
  --color-text-primary: #ebebeb;
  --color-text-muted: #9aa0a6;
  --color-accent-primary: #73d4b0;
  --color-accent-secondary: #d8c7fa;
  --color-danger: #f28b82;
  --color-warning: #fbbc04;
  --color-info: #8ab4f8;
}

[data-theme='light'] {
  --color-bg: #f8f7f9;
  --color-surface: #ffffff;
  --color-border: #6e6a6f;
  --color-text-primary: #071013;
  --color-text-muted: #6e6a6f;
  --color-accent-primary: #39b98a;
  --color-accent-secondary: #af8bf5;
  --color-danger: #d93025;
  --color-warning: #b06000;
  --color-info: #1967d2;
}
```

### Tailwind config (extracto)

```js
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        'text-primary': 'var(--color-text-primary)',
        'text-muted': 'var(--color-text-muted)',
        accent: {
          DEFAULT: 'var(--color-accent-primary)',
          secondary: 'var(--color-accent-secondary)',
        },
        danger: 'var(--color-danger)',
        warning: 'var(--color-warning)',
        info: 'var(--color-info)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      letterSpacing: {
        tightest: '-0.05em',
        tighter: '-0.03em',
      },
    },
  },
};
```

### Fonts

- Cargar DM Sans e Inter desde `next/font/google`.
- `display: 'swap'`, preload de los pesos usados (400, 500, 600).
- Subset `latin` alcanza para todos los casos de uso.

### Framework de componentes

- **shadcn/ui** como base, **fuertemente customizado** para respetar
  esta guía. No usar los defaults de shadcn sin override.
- Tokens de shadcn apuntan a los CSS variables de arriba.

---

## 12. Accesibilidad

Requisitos no negociables:

- **Contraste WCAG AA mínimo** (4.5:1 texto normal, 3:1 texto grande).
  - Verificar especialmente `text-muted` sobre `surface`.
  - Verificar acentos sobre sus fondos.
- **Focus ring visible** siempre. 2px `accent-primary` con offset.
- **Navegación por teclado** completa en flujos críticos (búsqueda,
  perfil, tag management).
- **Contraste del estado disabled** suficiente para ser leído.
- **No usar color como único indicador** de estado (rechazado ≠ solo
  rojo; incluir ícono o label).
- Todos los inputs con `<label>` asociado.
- Iconos decorativos con `aria-hidden="true"`; iconos funcionales
  con label.

---

## 13. Aplicación por tipo de vista

### Login / Auth

- Modo light por default (primera impresión, más institucional).
- Isotipo VAIRIX en el top-left, nombre del producto como título.
- Botón primary con accent (mint leaf en light).

### Dashboard / Home

- Modo dark por default.
- Hero con título en gradiente (base → accent-primary).
- Cards de KPIs con radio asimétrico.
- Actividad reciente como timeline con markers de flecha.

### Búsqueda (vista principal)

- Barra de búsqueda prominente, tipo Google.
- Filtros laterales (drawer o sidebar colapsable).
- Resultados en grid de cards de candidate.
- Altura mínima de card: 140px.

### Perfil de candidate

- Drawer lateral o página full con corner asimétrico en header.
- Tabs para: CV, Applications, Evaluations, Tags, Notes.
- Tags visibles arriba, editables inline.

### Admin / Sync / Logs

- Modo dark siempre.
- Tablas densas, mono para IDs y timestamps.
- Estados con colores semánticos (success/warning/danger).

---

## 14. Qué NO hacer

- ❌ Introducir tipografías nuevas (Roboto, Poppins, etc.).
- ❌ Introducir colores nuevos fuera de los semánticos ya definidos.
- ❌ Usar el logo de VAIRIX como logo del producto.
- ❌ Usar emojis como íconos funcionales (sí en contenido de usuario).
- ❌ Sombras dramáticas. Este producto es plano con elevaciones
  sutiles (sombra máxima: `0 2px 8px rgba(0,0,0,.08)` en light).
- ❌ Animaciones decorativas largas. Transiciones: 150–250ms, easing
  `ease-out`. Motion funcional, no gratuito.
- ❌ Modo "high contrast" como feature. Si hace falta,
  levantarlo como ADR.

---

## 15. Referencia

- Kit de marca original VAIRIX: `docs/brand/vairix-brand-kit.pdf`
  (subirlo al repo en `/docs/brand/`).
- Esta guía se consulta desde `CLAUDE.md` cuando Claude Code trabaja
  en UI.
- Cambios a esta guía requieren: discusión en el Project + ADR +
  update de tokens en el repo.
