---
title: Design system
description: Design tokens, shadcn-vue components and frontend conventions.
---

The dashboard is built on [shadcn-vue](https://www.shadcn-vue.com/) (style
`new-york`) on top of [Reka UI](https://reka-ui.com/), Tailwind CSS v4 and
[Lucide](https://lucide.dev/) icons. The components are copied into the
repository under `apps/dashboard/src/components/ui/<name>/`, so they are ours to
read and adjust. The theme lives in `apps/dashboard/src/style.css`.

## Adding a component

`apps/dashboard/components.json` holds the shadcn-vue configuration (aliases
`@/components/ui` and `@/lib/utils`, icon library `lucide`). To add a component,
copy it from the shadcn-vue registry into `src/components/ui/<name>/` and
import it through its `index.ts`:

```ts
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
```

`cn()` in `src/lib/utils.ts` merges classes with `tailwind-merge`, extended so
the custom `text-2xs` and `text-control` sizes are not mistaken for colors.

## Themes & accent

- Light and dark themes via `prefers-color-scheme`, overridable with
  `data-theme="light|dark"` on `:root`. The Tailwind `dark:` variant follows the
  same rule.
- A user-selectable **accent** color (`data-accent`) drives `--brand`, which is
  shadcn's `--primary` (and `--ring`, `--sidebar-primary`). It stays distinct
  from `--destructive`, so destructive UI never depends on the accent choice.

## Tokens

The shadcn tokens (`--background`, `--foreground`, `--card`, `--popover`,
`--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`,
`--input`, `--ring`, `--sidebar-*`, `--chart-*`) are defined for both themes
and exposed as Tailwind utilities through `@theme inline`: `bg-background`,
`text-muted-foreground`, `border-input`, `bg-primary/10`, and so on.

| Token | Utility | Use |
|---|---|---|
| `--primary` | `*-primary` | Primary/interactive accent (user-selectable) |
| `--destructive` | `*-destructive` | Destructive actions (fixed, not the accent) |
| `--success` / `--warning` / `--info` | `*-success` / `*-warning` / `*-info` | Status |
| `--violet` | `*-violet` | Filesystem category accent |
| `--foreground`, `--muted-foreground` | `text-*` | Text, from strongest to quietest |
| `--card`, `--muted`, `--accent` | `bg-*` | Surfaces, quiet fills, hover fills |

**Radius** comes from `--radius` (0.625rem) as in shadcn: `rounded-sm` to
`rounded-xl`.

**Typography** (`@theme`):

| Token | Utility | Use |
|---|---|---|
| `--font-sans` (Inter) | `font-sans` (default) | Everything the interface says to the human |
| `--font-mono` (JetBrains Mono) | `font-mono` | Machine data: paths, devices, commands, identifiers, sizes, form values, code |
| `--font-figure` (Space Mono) | `font-figure` | Key figures (tiles, widgets, versions) and status lines (`.status-text`) |
| `--text-2xs` (11px) | `text-2xs` | Labels, badges, meta, dense data; the floor of the scale |
| `--text-control` (13px) | `text-control` | Code editor, mobile density |
| `--tracking-caps` (0.08em) | `tracking-caps` | Every uppercase label |

Sizes come from the scale (`text-2xs`, `text-xs`, `text-control`, `text-sm` and
up), never arbitrary `text-[Npx]` values. The fonts are self-hosted through
`@fontsource` (imported in `main.ts`, only the weights in use), so the
dashboard renders the same without Internet access.

**Motion tokens**: `--dur-fast` (120ms), `--dur-base` (180ms), `--dur-slow`
(260ms) and `--ease-out`. Under `prefers-reduced-motion: reduce` all durations
collapse to ~1ms, so every animation degrades to instant. The shadcn components
animate with `tw-animate-css`.

## Named transitions

Three plain-CSS Vue transitions are available anywhere as
`<Transition name="…">`: `ui-fade`, `ui-pop` (scale, with a `ui-pop-move` for
`TransitionGroup` reordering), and `ui-slide-up`. Duration defaults to
`--dur-base`; override per element with `--ui-dur`.

> Custom properties inherit: an inline `--ui-dur` leaks to descendant
> transitions. Scope duration with a **class** (e.g. `.route-fade`) instead of an
> inline style when the transitioned element has animated children.

## Overlays and the desktop mode

Dialogs, menus, popovers, tooltips and context menus are the shadcn-vue ones.
Reka UI stacks them, so `Escape` and outside clicks only close the topmost
layer, and focus returns to the trigger.

- **`ui/Modal.vue`**: the app dialog shell on top of the Reka dialog, with the
  same contract for every caller (mount with `v-if`, listen to `@close`, which
  fires after the leave animation). Inside a desktop-mode window it teleports
  to the window's **modal host** (`lib/modal-host.ts`) and is non-modal, so it
  only blocks its own window: it draws its own backdrop and keeps `Tab` inside
  the panel. Elsewhere it is a regular modal dialog. Props: `panelClass`,
  `closeOnBackdrop`, `showClose`, `preventClose` (blocks Escape/backdrop
  during a busy operation).
- The desktop shell root has `isolation: isolate`, so window z-indexes never
  cover the menus and popovers portaled to `<body>`.
- A Reka context menu trigger ignores an event whose default was prevented:
  children inside a `ContextMenuTrigger` must not call `preventDefault()` or
  `stopPropagation()` on `contextmenu` unless they mean to opt out.

## Shared components

- **`lib/confirm.ts` + `ui/ConfirmDialog.vue`**: promise-based `useConfirm()`
  on the shadcn alert dialog; prefer it over `window.confirm`.
- **`lib/toast.ts`**: `useToast()` over `vue-sonner` (the shadcn toaster),
  mounted once in `DashboardLayout`.
- **`ui/` helpers** built from shadcn parts: `EmptyState`, `ErrorState`,
  `LoadingSpinner`, `LoadingState`, `Pagination`, `SearchInput`,
  `SortableHeader`, `SegmentedBar` (Reka progress), `Hint` (popover),
  `GroupPicker` (popover + command).
- **`components/storage/dialogs/`**: device dialogs (`DeviceFormatWizard`,
  `DeviceMountDialog`, `DeviceUnmountDialog`) and a generic
  `ConfirmDestroyDialog` (optional "type NAME to confirm" gate), reused by all
  four storage sections instead of duplicating markup.
- **`components/desktop/AppIcon.vue`**: maps each `AppId` to its Lucide icon.

## Shared utility classes

Only a few typographic helpers remain under `@layer components` in
`style.css`: `.eyebrow` (uppercase section label), `.status-text` and
`.status-tag` (inline status lines), `.loading-appear` (loaders that show after
200ms). Anything else is a shadcn component or plain Tailwind utilities.

## Conventions

- Use a shadcn component when one fits (`Button`, `Input`, `Badge`,
  `DropdownMenu`, `Tabs`, `ToggleGroup`, `Collapsible`...) rather than styling
  a raw element.
- Reference tokens, not raw hex or default-palette classes (`bg-destructive/10`,
  not `bg-red-500/10`).
- Keep destructive UI on `destructive`, never the accent.
- Icons come from `@lucide/vue`; decorative icons get `aria-hidden="true"` and
  icon-only buttons an `aria-label`.
- Everything must remain legible and functional under `prefers-reduced-motion`
  and in both themes.
