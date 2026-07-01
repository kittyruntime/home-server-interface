# Design: Design System Refresh (Nothing-style → balanced technical/soft)

**Date:** 2026-07-01
**Status:** Approved

## Problem

The dashboard's current design system ("Nothing-inspired": monochrome, flat, no shadows, pill buttons, Space Mono ALL CAPS labels everywhere, single red accent) no longer fits daily use. It reads as cold and instrument-panel-like, lacks visual depth (cards barely distinguishable from the background), uses a too-narrow palette, and its shapes (999px pill buttons, 4-8px "technical" corners) feel harsh.

The goal is not to swap to the opposite extreme (the soft/rounded/premium `nas-ui-design-system` skill, Synology/QNAP-inspired) but to find a **balance**: keep a technical identity where it earns its place (data values, section labels), while making the everyday surface warmer, softer, and easier to read.

## Solution

Evolve the existing token system in `apps/dashboard/src/style.css` rather than replacing it wholesale. Existing token *names* (`--c-bg`, `--c-surface`, `--c-text-1/2/3`, `--c-accent`, `.btn`, `.panel-card`, `.badge`, `.eyebrow`, etc.) are preserved so components don't need renaming — only their values and a handful of new tokens.

### Color

- Backgrounds warmed slightly: light `--c-bg: #f7f7f8` (was `#f5f5f5`); dark `--c-bg: #0a0a0b` (was pure `#000000` OLED black), surfaces `#141416` / `#1c1c1f`.
- `--c-accent` stays user-customizable (red default `#d71921`, plus orange/blue/green/purple), used for primary actions and active state — unchanged mechanism.
- **New fixed token `--c-danger: #d71921`** (NOT tied to the accent picker — same hex as today's default accent, but no longer reassigned when the user picks a different accent color) for destructive actions and error states. Today `.btn-danger`/error badges reuse `--c-accent`, so picking a non-red accent makes delete buttons ambiguous. Decoupling danger from accent fixes this.
- `--c-success`, `--c-warning`, `--c-info` unchanged in role: sobre, applied to the value/badge itself, never to row/section backgrounds.
- Add `--c-danger-subtle` (mirrors existing `--c-accent-subtle` pattern) for the danger badge/button hover tint.

### Typography

- **Inter becomes the single typeface** for navigation, buttons, labels, and body text — removes the Space Mono ALL CAPS treatment from buttons/labels/badges (the main source of "cold" feedback).
- **Space Mono is retained but scoped**: numeric/technical values only — CPU/RAM/disk metrics, file sizes, IP/ports, timestamps in logs, hashes/IDs. This keeps a technical identity without applying it to the whole UI.
- **`--font-display` (Doto) is removed.** Hero numbers use Inter Semibold/Bold for the number, optionally with the unit in Space Mono beside it.
- Buttons and labels move from ALL CAPS to sentence case (e.g. "Install update" instead of "INSTALL UPDATE").
- `.eyebrow` (section titles) moves from Space Mono ALL CAPS to Inter: small-caps or `uppercase` + `tracking-wide` at medium weight, `--c-text-3`. Keeps the "instrument label" function without the mono coldness.

### Shape & elevation

New radius scale (Tailwind arbitrary values / CSS custom properties, all in `rem`):
- `--radius-sm: 0.5rem` — inputs, badges, small buttons
- `--radius-md: 0.625rem` — standard buttons, controls (replaces the 999px pill)
- `--radius-lg: 0.875rem` — cards/panels (was `0.75rem`)
- `--radius-xl: 1rem` — modals

New shadow tokens, two levels, always paired with the existing border (never shadow-only, to avoid a glassmorphism look):
- `--shadow-sm`: resting elevation for cards/panels — `0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.03)`
- `--shadow-md`: hover/active elevation for clickable cards and modals — `0 4px 12px rgba(0,0,0,0.08)`
- Dark mode: shadows are barely visible on near-black backgrounds by design; separation there relies primarily on `--c-border` + the `--c-surface`/`--c-surface-alt` contrast, with shadows as a light supplementary cue only.

### Components

- **Buttons** (`.btn` + variants): `--radius-md`, Inter, sentence case. `primary`/`outline`/`ghost` keep their current color logic; `danger` switches from `--c-accent` to the new `--c-danger` token, with `--c-danger-subtle` as the hover background.
- **Badges** (`.badge` + variants): `--radius-sm` instead of pill; move from border-only to a soft tinted background (`color-mix` with the status color at ~10-15%) + colored text — softer and more scannable than a bare outline, still restrained (no saturated fills).
- **Cards/panels** (`.panel-card`): keep the existing border, add `--shadow-sm` at rest; clickable/navigable cards add `--shadow-md` on hover.
- **Inputs** (`.ui-input`): `--radius-sm`/`--radius-md`, no structural change beyond radius and the typography change (already Inter).
- **Modals**: `--radius-xl`, `--shadow-md`.

### States & feedback

No structural change: loaders stay as sober spinners, inline `status-text`/`status-tag` and toast notifications are kept as-is, only re-skinned with the new radius/shadow/color tokens. Disabled state stays `opacity: 0.4`. Focus ring stays a 2px `--c-accent` outline.

## Architecture

Single source of truth: `apps/dashboard/src/style.css`. All changes are token-value edits and new `@layer components` rules — no component `.vue` file needs its class names changed, since `.btn`, `.badge`, `.panel-card`, `.eyebrow`, `--c-*` custom properties are all reused as-is. Components that hardcode Space Mono/ALL CAPS classes directly (rather than via `.eyebrow`/`.btn`) will need individual review to move to Inter, since that styling isn't fully centralized in every case (e.g. some section headers apply `font-mono uppercase` utility classes inline rather than through a shared class).

## Out of scope

- No new components or layout changes (sidebar, panels, desktop windows stay structurally the same).
- No changes to the accent color picker mechanism (still 5 user-selectable hues).
- No per-module color coding (Storage ≠ blue, Containers ≠ purple, etc.) — rejected in favor of the sober functional-color approach.
- No glassmorphism/blur effects.
- Migrating every `.vue` file that hardcodes `font-mono uppercase` inline (instead of using `.eyebrow`) is implementation-plan work, not part of this design decision — the plan should audit and enumerate these call sites.

## Verification

- `cd apps/dashboard && pnpm exec vue-tsc -b` → 0 errors (no logic changes expected, but confirms no accidental breakage).
- Visual check in both light and dark mode: cards visibly separated from background via shadow, buttons no longer pill-shaped, labels no longer ALL CAPS mono, danger buttons stay red regardless of the selected accent color.
- Spot-check a metrics-heavy screen (System section) to confirm Space Mono is still applied to numeric values.
