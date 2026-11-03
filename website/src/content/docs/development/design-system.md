---
title: Design system
description: Themes, daisyUI components and frontend conventions.
---

The dashboard is built on [daisyUI](https://daisyui.com/) 5, Tailwind CSS v4 and
[Lucide](https://lucide.dev/) icons. daisyUI provides the component classes and
the themes; the wrappers under `apps/dashboard/src/components/ui/<name>/` give
them Vue components with stable names (`Button`, `Input`, `DropdownMenu`,
`Tabs`...), so screens import them through each folder's `index.ts`. The theme
setup lives in `apps/dashboard/src/style.css`.

## Using a component

Import the wrapper, not a raw element, when one fits:

```ts
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
```

`cn()` in `src/lib/utils.ts` merges classes with `tailwind-merge`, extended so
the custom `text-2xs` and `text-control` sizes are not mistaken for colors.

## Themes and appearance

- The daisyUI plugin in `style.css` enables 35 themes. The owner picks one in
  Settings, or **Auto**, which follows `prefers-color-scheme` (`light` or
  `dark`). The choice is stored on the account and applied as `data-theme` on
  `:root`.
- Appearance settings also cover an **accent** (theme default, red, orange,
  blue, green or purple), the **roundness** of corners (five steps) and the
  **density** of controls (compact, default, roomy). Roundness and density are
  applied by overriding daisyUI's `--radius-*` and `--size-*` variables; the
  neutral position leaves the theme's own values.
- An accent overrides `--color-primary` and `--color-primary-content` only.
  `error` stays distinct from it, so destructive UI never depends on the accent
  choice.
- Every screen must work with every theme, accent, roundness step and density.

## Colors

Use daisyUI semantic names only: `base-100/200/300`, `base-content`, `primary`,
`secondary`, `accent`, `neutral`, `info`, `success`, `warning`, `error` and
their `-content` pairs (`bg-base-200`, `text-base-content/70`, `bg-error/10`,
`border-base-300`). Never raw hex or default-palette classes (`bg-red-500`).

| Role | Use |
|---|---|
| `primary` | The one action a view exists for; where the accent lands |
| `error` | Failures and destructive actions, never the accent |
| `success` / `warning` / `info` | Status |
| `base-content` and its opacity steps | Text, from strongest to quietest |
| `base-100` / `base-200` / `base-300` | Page, quiet fills, borders |

Role colors are tuned for fills, so as text they can be unreadable on some
themes. `style.css` pulls `text-<role>`, `hover:text-<role>`, the destructive
menu and alert forms and link buttons halfway toward the content color. Use
the normal utilities and keep the text role for meaning, not decoration.

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
(260ms) and `--ease-out`. Under `prefers-reduced-motion: reduce` the three
durations shrink to 1ms, so every transition built on them becomes instant.

## Named transitions

Plain-CSS Vue transitions are available anywhere as `<Transition name="…">`:
`ui-fade`, `ui-pop` (fade with a 0.97 scale, with a `ui-pop-move` for
`TransitionGroup` reordering) and `ui-slide-up`. Duration defaults to
`--dur-base`; override per element with `--ui-dur`. Floating layers (menus,
popovers, tooltips) use the `ui-float` class, which fades and scales in once the
layer is placed, with a small offset taken from its side.

> Custom properties inherit: an inline `--ui-dur` leaks to descendant
> transitions. Scope duration with a **class** (e.g. `.route-fade`) instead of an
> inline style when the transitioned element has animated children.

## Overlays and the desktop mode

Menus, popovers, tooltips and context menus are local components built on the
browser's Popover API and positioned with `@floating-ui/dom`
(`lib/use-anchored-popover.ts`). Dialogs are native `<dialog>` elements
(`lib/native-dialog.ts`), so focus is trapped and restored by the browser,
`Escape` closes the topmost layer and the page behind cannot scroll.

- **`ui/Modal.vue`**: the app dialog shell, with the same contract for every
  caller (mount with `v-if`, listen to `@close`, which fires after the leave
  animation). Inside a desktop-mode window it teleports to the window's
  **modal host** (`lib/modal-host.ts`) and is non-modal, so it only blocks its
  own window: it draws its own backdrop and keeps `Tab` inside the panel.
  Elsewhere it is a regular modal dialog. Props: `panelClass`,
  `closeOnBackdrop`, `showClose`, `preventClose` (blocks Escape/backdrop
  during a busy operation).
- Toasts, tooltips and menus live in the top layer, so they show above open
  dialogs and are not clipped by windows or scrolling lists.
- The desktop shell root has `isolation: isolate`, so window z-indexes never
  cover the layers above them.
- A `ContextMenuTrigger` ignores an event whose default was prevented:
  children inside it must not call `preventDefault()` or `stopPropagation()` on
  `contextmenu` unless they mean to opt out.

## Shared components

- **`lib/confirm.ts` + `ui/ConfirmDialog.vue`**: promise-based `useConfirm()`;
  prefer it over `window.confirm`.
- **`lib/toast.ts`**: `useToast()` over `vue-sonner`, mounted once in
  `DashboardLayout`.
- **`ui/` helpers**: `EmptyState`, `ErrorState`, `LoadingSpinner`,
  `LoadingState`, `Pagination`, `SearchInput`, `SortableHeader`,
  `SegmentedBar`, `Hint` (popover), `GroupPicker` (searchable list).
- **`components/storage/dialogs/`**: device dialogs (`DeviceFormatWizard`,
  `DeviceMountDialog`, `DeviceUnmountDialog`) and a generic
  `ConfirmDestroyDialog` (optional "type NAME to confirm" gate), reused by all
  four storage sections instead of duplicating markup.
- **`components/desktop/AppIcon.vue`**: maps each `AppId` to its Lucide icon.

## Shared utility classes

Only a few helpers live in `style.css` next to daisyUI: `.eyebrow` (uppercase
section label), `.status-text` and `.status-tag` (inline status lines),
`.loading-appear` (loaders that show after 200ms), the `ui-*` transitions and
`ui-float`. Anything else is a daisyUI component class or plain Tailwind
utilities.

## Conventions

- Use a `ui/` wrapper when one fits rather than styling a raw element.
- Reference daisyUI color names, not raw hex or default-palette classes
  (`bg-error/10`, not `bg-red-500/10`).
- Keep destructive UI on `error`, never the accent.
- Icons come from `@lucide/vue`; decorative icons get `aria-hidden="true"` and
  icon-only buttons an `aria-label`.
- Everything must remain legible and functional under `prefers-reduced-motion`,
  in light and dark themes, and at the extremes of roundness and density.
