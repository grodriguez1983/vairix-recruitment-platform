---
name: ui-components
description: Cómo construir componentes UI respetando el kit de marca VAIRIX, la guía de estilos del producto, accesibilidad, y patrones densos de data (cards, tablas, drawers, chips). Usar cuando la tarea requiera crear o modificar componentes en src/app/ o src/components/.
---

# UI Components

## Cuándo aplicar este skill

- Crear un componente nuevo (card, tabla, drawer, modal, form).
- Implementar una vista completa (búsqueda, perfil, shortlist).
- Ajustar estilos o estados (hover, focus, empty state).
- Revisar si un componente cumple accesibilidad.

## Principios no negociables

1. **Usar tokens CSS variables**, nunca hex hardcoded.
   `color: var(--color-accent-primary)` ✅
   `color: #73D4B0` ❌
2. **Dark mode por default**, light mode obligatorio para impresión.
3. **Tipografía**: DM Sans (display) e Inter (body). Nada más.
4. **Lucide** para íconos. Nada más.
5. **shadcn/ui como base**, fuertemente customizado. No usar
   defaults.
6. **Accesibilidad WCAG AA** como mínimo. Focus visible siempre.
7. **Densidad media-alta** — este es un producto de datos, no de
   marketing.

## Tokens a usar siempre

```tsx
// Colores
"bg-bg"                // fondo de page
"bg-surface"           // cards, panels
"border-border"        // divisores
"text-text-primary"    // texto principal
"text-text-muted"      // secundario
"bg-accent"            // CTA primary, success
"bg-accent-secondary"  // tags, highlights
"bg-danger"            // destructive
"bg-warning"           // alertas leves
"bg-info"              // neutro informativo

// Radios
"rounded-sm"           // 6px  — inputs, chips
"rounded-md"           // 12px — botones
"rounded-lg"           // 20px — cards
"rounded-xl"           // 32px — hero, modal

// Tipografía
"font-display"         // DM Sans — títulos
"font-sans"            // Inter  — body
"font-mono"            // JetBrains Mono — ids, hashes
```

## Patrón de card de candidate (el más usado)

```tsx
import { type FC } from 'react';
import { cn } from '@/lib/ui/cn';

type Props = {
  candidate: CandidateCard;
  isShortlisted?: boolean;
  onClick?: () => void;
};

export const CandidateCard: FC<Props> = ({
  candidate, isShortlisted = false, onClick,
}) => (
  <article
    onClick={onClick}
    className={cn(
      'group relative p-5 bg-surface border border-border',
      'transition-all duration-200',
      'hover:border-accent hover:-translate-y-0.5',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      // Corner asimétrico solo si está shortlisted
      isShortlisted
        ? 'rounded-[20px_20px_20px_64px]'
        : 'rounded-lg',
    )}
    role="button"
    tabIndex={0}
  >
    <Avatar src={candidate.avatarUrl} alt="" size={48} />
    <h3 className="font-display text-[1.375rem] leading-tight tracking-tighter mt-3">
      {candidate.fullName}
    </h3>
    <p className="text-text-muted text-sm mt-1">
      {candidate.headline}
    </p>
    <TagList tags={candidate.tags} className="mt-3" />
    <div className="text-xs text-text-muted mt-4 flex gap-3">
      <span>{candidate.lastActivity}</span>
      <span>·</span>
      <span>{candidate.source}</span>
    </div>
  </article>
);
```

Reglas del corner asimétrico (derivadas de `ui-style-guide.md` §7):
- Solo UN corner exagerado por elemento.
- Mismo corner exagerado en elementos del mismo tipo.
- Solo en elementos **destacados**, no en toda la UI.

## Patrón de tabla densa

```tsx
<table className="w-full">
  <thead className="sticky top-0 bg-surface">
    <tr>
      <th className="text-xs uppercase tracking-wider text-text-muted px-4 py-3 text-left">
        Candidate
      </th>
      {/* más columnas */}
    </tr>
  </thead>
  <tbody>
    {rows.map((row, i) => (
      <tr
        key={row.id}
        className={cn(
          'transition-colors',
          i % 2 === 1 && 'bg-surface/50',
          'hover:bg-accent-secondary/[.08]',
        )}
        style={{ height: 48 }}
      >
        {/* celdas */}
      </tr>
    ))}
  </tbody>
</table>
```

## Botones

```tsx
// Primary — uno por pantalla
<Button variant="primary">Guardar</Button>

// Secondary
<Button variant="secondary">Cancelar</Button>

// Ghost
<Button variant="ghost">Limpiar filtros</Button>

// Destructive
<Button variant="destructive">
  <Trash2 size={20} /> Eliminar
</Button>
```

Implementación base (extendiendo shadcn/ui):

```tsx
const variants = cva(
  'inline-flex items-center gap-2 rounded-md font-medium transition ' +
  'focus-visible:outline-none focus-visible:ring-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-bg hover:brightness-110 focus-visible:ring-accent',
        secondary: 'border border-accent text-accent hover:bg-accent/10',
        ghost: 'text-text-primary hover:bg-surface',
        destructive: 'bg-danger text-white hover:brightness-110',
      },
      size: {
        sm: 'px-5 py-2.5 text-sm',
        md: 'px-6 py-3 text-sm',
        lg: 'px-8 py-4 text-base',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);
```

## Form inputs

- Radio: `rounded-sm` (6px).
- Border: `border-border` default, `ring-2 ring-accent` en focus.
- Placeholder: `placeholder:text-text-muted`.
- Labels **arriba** del input, nunca floating.
- Error: mensaje **debajo** del input, `text-danger` + ícono.

## Drawer de perfil (UC-04)

- 480px de ancho en desktop, full-screen en mobile.
- Corner asimétrico en el corner opuesto al lado de aparición
  (drawer de derecha → corner top-left exagerado).
- Backdrop: `bg-black/60`.
- Close button siempre visible, top-right.
- Tabs (CV, Applications, Evaluations, Tags, Notes) como segmented
  control.

## Empty states

Usar el **elemento flecha** del isotipo VAIRIX como invitación
(§7 de la guía):

```tsx
<EmptyState
  title="Empezá una búsqueda"
  description="Escribí lo que estás buscando en lenguaje natural."
  action={<Button>Abrir búsqueda</Button>}
  illustration="arrow"
/>
```

## Accesibilidad (checklist por componente)

- [ ] Contraste WCAG AA ≥ 4.5:1 en texto normal, ≥ 3:1 en grande.
- [ ] Focus visible con `ring-2 ring-accent` y `ring-offset-2`.
- [ ] Navegable por teclado (tab, shift+tab, enter, esc).
- [ ] Labels asociados a inputs (`htmlFor` / `id`).
- [ ] `aria-label` en botones solo con ícono.
- [ ] `aria-hidden="true"` en íconos decorativos.
- [ ] Estado disabled con contraste suficiente para ser leído.
- [ ] Color nunca es único indicador (agregar ícono o texto).

## Qué NO hacer

- ❌ Introducir tipografías nuevas (Roboto, Poppins, etc.).
- ❌ Colores hex hardcoded en components.
- ❌ Usar el logo de VAIRIX como logo del producto.
- ❌ Emojis como íconos funcionales.
- ❌ Sombras dramáticas. Max: `0 2px 8px rgba(0,0,0,.08)`.
- ❌ Animaciones > 250ms para interacciones comunes.
- ❌ Modo "high contrast" feature — requiere ADR si aparece.
- ❌ `localStorage` para data crítica del negocio (ver CLAUDE.md
  restricciones de artifacts).

## Checklist pre-PR

- [ ] Todos los colores vienen de CSS variables.
- [ ] Componente funciona en dark y light.
- [ ] Focus ring visible.
- [ ] Funciona con keyboard.
- [ ] Tests E2E en Playwright si es parte de un UC crítico.
- [ ] Storybook story (cuando se agregue Storybook, Fase 2+).

## Referencias

- `docs/ui-style-guide.md` — guía canónica de estilos.
- CLAUDE.md "Code Standards".
- `docs/use-cases.md` — UCs que definen qué componentes existen.
- Kit de marca VAIRIX — en `docs/brand/` cuando se suba.
