# Design system

The dashboard's look is driven by a small set of **design tokens** and shared
utility classes defined in `apps/dashboard/src/style.css`. Components reference
tokens rather than hard-coded values, so themes and the accent picker stay
consistent everywhere.

## Themes & accent

- Light and dark themes via `prefers-color-scheme`, overridable with
  `data-theme="light|dark"` on `:root`.
- A user-selectable **accent** color (`data-accent`), kept distinct from the
  fixed **danger** color so destructive UI never depends on the accent choice.

## Tokens

**Semantic colors** (`--c-*`) are exposed as Tailwind utilities through an
`@theme inline` bridge, so components write `text-danger`, `bg-success/10`,
`accent-accent`, `text-violet`, etc. — not raw palette classes.

| Token | Utility | Use |
|---|---|---|
| `--c-accent` | `*-accent` | Primary/interactive accent (user-selectable) |
| `--c-danger` | `*-danger` | Destructive actions (fixed, not the accent) |
| `--c-success` / `--c-warning` / `--c-info` | `*-success` / `*-warning` / `*-info` | Status |
| `--c-violet` | `*-violet` | Filesystem category accent |
| `--c-text-1/2/3`, `--c-surface*`, `--c-border*` | via `var()` | Text, surfaces, borders |

**Radius scale** (`@theme`) remaps Tailwind's `rounded-*` utilities to a shared
scale: `sm` inputs/badges · `md` buttons/controls · `lg` cards/panels ·
`xl` modals/windows.

**Motion tokens**: `--dur-fast` (120ms), `--dur-base` (180ms), `--dur-slow`
(260ms) and `--ease-out`. Under `prefers-reduced-motion: reduce` all durations
collapse to ~1ms, so every animation degrades to instant.

## Named transitions

Three plain-CSS Vue transitions are available anywhere as
`<Transition name="…">`: `ui-fade`, `ui-pop` (scale, with a `ui-pop-move` for
`TransitionGroup` reordering), and `ui-slide-up`. Duration defaults to
`--dur-base`; override per element with `--ui-dur`.

> Custom properties inherit — an inline `--ui-dur` leaks to descendant
> transitions. Scope duration with a **class** (e.g. `.route-fade`) instead of an
> inline style when the transitioned element has animated children.

## Shared components

- **`ui/Modal.vue`** — the one modal used across the app. Handles enter/leave
  animation, teleports to a **host window** when opened inside desktop mode
  (via `provide`/`inject` of `modal-host`) and otherwise to `<body>`, and joins
  the layered **Escape** stack. Props: `panelClass`, `closeOnBackdrop`,
  `showClose`, `preventClose` (blocks Escape/backdrop during a busy operation).
- **`lib/escLayer.ts`** — a shared Escape-key stack so only the topmost overlay
  closes on `Escape` (used by Modal, Launchpad and dropdowns).
- **`lib/confirm.ts` + `ui/ConfirmDialog.vue`** — promise-based `useConfirm()`
  styled like the rest of the app; prefer it over `window.confirm`.
- **`components/storage/dialogs/`** — device dialogs (`DeviceFormatWizard`,
  `DeviceMountDialog`, `DeviceUnmountDialog`) and a generic
  `ConfirmDestroyDialog` (optional "type NAME to confirm" gate), reused by all
  four storage sections instead of duplicating markup.
- **`components/desktop/AppIcon.vue`** — the custom monochrome app-glyph family
  (24px grid, consistent stroke, filled-dot details), keyed by `AppId`.

## Shared utility classes

Defined under `@layer components` in `style.css` so Tailwind utilities still win
the cascade: `.btn` (+ `.btn-primary/-outline/-ghost/-danger`, `.btn-sm/-xs`),
`.ui-input`, `.badge` (+ variants), `.panel-card`, `.eyebrow`, `.ui-divider`,
`.status-text`. Reuse these instead of repeating Tailwind strings.

## Conventions

- Reference tokens, not raw hex or default-palette classes.
- Use the semantic utilities (`bg-danger/10`, not `bg-[var(--c-danger)]/10`;
  `accent-accent`, not `accent-[var(--c-accent)]`).
- Keep destructive UI on `danger`, never the accent.
- Everything must remain legible and functional under `prefers-reduced-motion`
  and in both themes.
