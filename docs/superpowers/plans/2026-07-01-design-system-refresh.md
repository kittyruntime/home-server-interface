# Design System Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the dashboard's "Nothing-inspired" flat/monochrome/no-shadow design system into a warmer, softer balance — Inter replaces Space Mono for UI chrome (mono stays only for technical data values), buttons/badges lose their pill shape for moderate rounding, cards/modals gain subtle shadows, and destructive actions get a color token independent of the user's chosen accent.

**Architecture:** Single source of truth is `apps/dashboard/src/style.css` — all shared classes (`.btn`, `.badge`, `.panel-card`, `.ui-input`, `.eyebrow`) and CSS custom properties (`--c-*`, new `--radius-*`/`--shadow-*`) live there, so most components need zero changes. A small, fully-enumerated set of components hardcode the old mono/uppercase/shadow treatment as inline Tailwind utilities instead of the shared classes; those are migrated individually in dedicated tasks.

**Tech Stack:** Vue 3 `<script setup>` + TypeScript strict, Tailwind v4, CSS custom properties (`var(--c-*)`).

**Design spec:** `docs/superpowers/specs/2026-07-01-design-system-refresh-design.md` — read before starting if anything below is unclear on intent.

## Global Constraints

- Vue 3 `<script setup>` + TypeScript strict throughout.
- After every task: `cd apps/dashboard && pnpm exec vue-tsc -b` must pass with 0 errors.
- Tailwind v4 with `var(--c-*)` CSS tokens — no new component-scoped CSS files, everything shared goes in `apps/dashboard/src/style.css`.
- All UI text stays in English (no copy changes in this plan — only class/token changes).
- Commit style: `feat(scope): ...` / `fix(scope): ...` / `chore(scope): ...`.
- No new components, no layout changes, no changes to the accent color picker mechanism (still 5 user-selectable hues), no per-module color coding, no glassmorphism/blur.

---

### Task 1: Add new design tokens to style.css

**Files:**
- Modify: `apps/dashboard/src/style.css:8-93`

**Interfaces:**
- Produces: CSS custom properties `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--shadow-sm`, `--shadow-md`, `--c-danger`, `--c-danger-subtle`, plus updated values for `--c-bg` (light+dark) and `--c-surface`/`--c-surface-alt`/`--c-surface-deep` (dark only). All later tasks consume these.

- [ ] **Step 1: Add radius and shadow tokens**

Insert a new block right after the existing font-tokens `:root` block (after line 12, before the accent block that starts at line 14):

```css
/* Shape & elevation — moderate rounding, two subtle shadow levels paired
   with the existing border (never shadow-only, to avoid glassmorphism). */
:root {
  --radius-sm: 0.5rem;
  --radius-md: 0.625rem;
  --radius-lg: 0.875rem;
  --radius-xl: 1rem;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 1px rgba(0, 0, 0, 0.03);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
}
```

- [ ] **Step 2: Add the `--c-danger` tokens**

In the existing accent block (currently lines 16-24):

```css
:root {
  --c-accent:        #d71921;
  --c-accent-subtle: color-mix(in srgb, var(--c-accent) 13%, transparent);
  --c-accent-fg:     #ffffff;

  --c-success: #4a9e5c;
  --c-warning: #d4a843;
  --c-info:    #007aff;
}
```

add `--c-danger` and `--c-danger-subtle` as fixed tokens (not tied to the accent picker):

```css
:root {
  --c-accent:        #d71921;
  --c-accent-subtle: color-mix(in srgb, var(--c-accent) 13%, transparent);
  --c-accent-fg:     #ffffff;

  --c-danger:        #d71921;
  --c-danger-subtle: color-mix(in srgb, var(--c-danger) 13%, transparent);

  --c-success: #4a9e5c;
  --c-warning: #d4a843;
  --c-info:    #007aff;
}
```

- [ ] **Step 3: Warm the light-mode background**

In the light block (currently lines 32-50), change:

```css
  --c-bg:            #f5f5f5;
```

to:

```css
  --c-bg:            #f7f7f8;
```

Leave `--c-sidebar`, `--c-surface`, `--c-surface-alt`, `--c-surface-deep`, borders, text colors unchanged in this block.

- [ ] **Step 4: Soften the dark-mode background and surfaces (both dark blocks)**

The file defines dark colors twice — once in `@media (prefers-color-scheme: dark)` (currently lines 53-73) and once in `:root[data-theme="dark"]` (currently lines 75-93). Apply the same three value changes in **both** blocks:

```css
    --c-bg:            #000000;
    --c-sidebar:       #111111;
    --c-surface:       #111111;
    --c-surface-alt:   #1a1a1a;
    --c-surface-deep:  #1a1a1a;
```

becomes:

```css
    --c-bg:            #0a0a0b;
    --c-sidebar:       #141416;
    --c-surface:       #141416;
    --c-surface-alt:   #1c1c1f;
    --c-surface-deep:  #1c1c1f;
```

(`--c-sidebar` takes the same new value as `--c-surface` in both blocks, matching the existing pattern where the two were already equal.) Leave borders, hover, text colors, and `--c-info` unchanged in both blocks.

- [ ] **Step 5: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors (CSS-only change, no TS surface affected).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/style.css
git commit -m "feat(design-system): add radius/shadow/danger tokens, warm background colors"
```

---

### Task 2: Restyle buttons (`.btn` + variants)

**Files:**
- Modify: `apps/dashboard/src/style.css` (`.btn` rule block, currently lines 124-181)

**Interfaces:**
- Consumes: `--radius-md`, `--radius-sm`, `--c-danger`, `--c-danger-subtle` from Task 1.
- Produces: no new class names — `.btn`, `.btn-xs`, `.btn-sm`, `.btn-primary`, `.btn-outline`, `.btn-ghost`, `.btn-danger` all keep their names; only declarations change. Nothing downstream needs new interfaces.

- [ ] **Step 1: Update the `.btn` base rule**

Change:

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  transition: color 150ms, background-color 150ms, border-color 150ms, opacity 150ms;
  cursor: pointer;
  border: 1px solid transparent;
  outline: none;
  white-space: nowrap;
}
```

to:

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  border-radius: var(--radius-md);
  font-family: var(--font-body);
  font-size: 0.8125rem;
  font-weight: 500;
  transition: color 150ms, background-color 150ms, border-color 150ms, opacity 150ms, box-shadow 150ms;
  cursor: pointer;
  border: 1px solid transparent;
  outline: none;
  white-space: nowrap;
}
```

(dropped `text-transform: uppercase` and `letter-spacing: 0.06em` — button labels in components are already written in sentence case, e.g. "Install update", "Check now", so no component copy changes are needed.)

- [ ] **Step 2: Update `.btn-ghost`'s radius to use the token**

Change:

```css
.btn-ghost {
  color: var(--c-text-3);
  background: transparent;
  border-radius: 0.375rem;
}
```

to:

```css
.btn-ghost {
  color: var(--c-text-3);
  background: transparent;
  border-radius: var(--radius-sm);
}
```

- [ ] **Step 3: Point `.btn-danger` at the new fixed danger token**

Change:

```css
.btn-danger {
  color: var(--c-accent);
  border-color: var(--c-accent);
  background: transparent;
}
.btn-danger:hover:not(:disabled) {
  background-color: var(--c-accent-subtle);
}
```

to:

```css
.btn-danger {
  color: var(--c-danger);
  border-color: var(--c-danger);
  background: transparent;
}
.btn-danger:hover:not(:disabled) {
  background-color: var(--c-danger-subtle);
}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors.

- [ ] **Step 5: Manual check**

Start the dev server (`cd apps/dashboard && pnpm dev`) and open any panel with buttons (e.g. Settings → Updates). Confirm: buttons are rounded rectangles (not pills), labels are sentence case, not ALL CAPS, and are set in Inter (not monospace). Open Files → delete a file to trigger a danger button/confirm dialog and confirm it's still red even if a non-red accent is selected in Settings → Profile.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/style.css
git commit -m "feat(design-system): restyle buttons — Inter, moderate radius, decoupled danger color"
```

---

### Task 3: Restyle badges (`.badge` + variants)

**Files:**
- Modify: `apps/dashboard/src/style.css` (`.badge` rule block, currently lines 198-213)

**Interfaces:**
- Consumes: `--radius-sm`, `--c-accent-subtle`, `--c-hover` (existing token) from Task 1 / existing tokens.
- Produces: no new class names — `.badge`, `.badge-accent`, `.badge-muted`, `.badge-violet`, `.badge-admin` keep their names.

- [ ] **Step 1: Update the `.badge` base rule**

Change:

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--c-border-strong);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
```

to:

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
```

(dropped the `border` — badges move from border-only to a soft tinted background per variant, set below.)

- [ ] **Step 2: Update badge variants to soft tinted backgrounds**

Change:

```css
.badge-accent  { border-color: var(--c-accent); color: var(--c-accent); }
.badge-muted   { border-color: var(--c-border-strong); color: var(--c-text-3); }
.badge-violet  { border-color: var(--c-border-strong); color: var(--c-text-2); }
.badge-admin   { border-color: var(--c-accent); color: var(--c-accent); }
```

to:

```css
.badge-accent  { background-color: var(--c-accent-subtle); color: var(--c-accent); }
.badge-muted   { background-color: var(--c-hover); color: var(--c-text-3); }
.badge-violet  { background-color: var(--c-hover); color: var(--c-text-2); }
.badge-admin   { background-color: var(--c-accent-subtle); color: var(--c-accent); }
```

- [ ] **Step 3: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors.

- [ ] **Step 4: Manual check**

Open Settings → Users (badges show roles/admin tags) and Settings → Audit Log (category badges). Confirm badges show as soft rounded-rect tags with a tinted background instead of a bare outline, and are no longer ALL CAPS mono.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/style.css
git commit -m "feat(design-system): restyle badges — soft tinted backgrounds, moderate radius"
```

---

### Task 4: Restyle panel cards, inputs, and eyebrows

**Files:**
- Modify: `apps/dashboard/src/style.css` (`.ui-input` block ~184-196, `.eyebrow` block ~218-226, `.panel-card` block ~228-233)

**Interfaces:**
- Consumes: `--radius-sm`, `--radius-lg`, `--shadow-sm`, `--shadow-md` from Task 1.
- Produces: `.panel-card` gains a `:hover` rule (new, additive — no class name changes, safe for every existing usage of `.panel-card`).

- [ ] **Step 1: Update `.ui-input` radius to use the token**

Change:

```css
.ui-input {
  width: 100%;
  background-color: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
  font-family: var(--font-body);
  color: var(--c-text-1);
  outline: none;
  transition: border-color 150ms;
}
```

to (only the `border-radius` line changes, value is the same 0.5rem, now expressed as the token):

```css
.ui-input {
  width: 100%;
  background-color: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-sm);
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
  font-family: var(--font-body);
  color: var(--c-text-1);
  outline: none;
  transition: border-color 150ms;
}
```

- [ ] **Step 2: Update `.eyebrow` to Inter**

Change:

```css
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-text-3);
}
```

to:

```css
.eyebrow {
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-text-3);
}
```

- [ ] **Step 3: Add shadow + updated radius to `.panel-card`**

Change:

```css
.panel-card {
  border-radius: 0.75rem;
  border: 1px solid var(--c-border);
  overflow: hidden;
}
```

to:

```css
.panel-card {
  border-radius: var(--radius-lg);
  border: 1px solid var(--c-border);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  transition: box-shadow 150ms;
}
.panel-card:hover {
  box-shadow: var(--shadow-md);
}
```

- [ ] **Step 4: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors.

- [ ] **Step 5: Manual check**

Open any Settings/Storage/Monitor panel. Confirm cards are visibly lifted off the background (subtle shadow, more rounded corners than before) in both light and dark mode, section eyebrow labels (e.g. "Current version" in Updates) are in Inter small-caps rather than monospace, and inputs are unaffected visually (radius value didn't change).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/style.css
git commit -m "feat(design-system): add card elevation, update input/eyebrow radius and typography"
```

---

### Task 5: Remove Doto display font, migrate hero numbers to Inter

**Files:**
- Modify: `apps/dashboard/src/style.css:9`
- Modify: `apps/dashboard/src/views/LoginView.vue:32`
- Modify: `apps/dashboard/src/components/desktop/DesktopWidgets.vue:40`
- Modify: `apps/dashboard/src/components/dashboard/DashboardPanel.vue:112`

**Interfaces:**
- Consumes: nothing new.
- Produces: removes the `--font-display` custom property entirely — no other file references it after this task (verified below).

- [ ] **Step 1: Remove the `--font-display` token**

In `apps/dashboard/src/style.css`, change:

```css
:root {
  --font-display: "Doto", "Space Mono", monospace;
  --font-body:    "Inter", system-ui, sans-serif;
  --font-mono:    "Space Mono", "JetBrains Mono", "SF Mono", monospace;
}
```

to:

```css
:root {
  --font-body: "Inter", system-ui, sans-serif;
  --font-mono: "Space Mono", "JetBrains Mono", "SF Mono", monospace;
}
```

- [ ] **Step 2: Update `LoginView.vue`'s hero wordmark**

In `apps/dashboard/src/views/LoginView.vue:32`, change:

```html
        <div class="text-5xl text-[var(--c-text-display)] mb-2" style="font-family: var(--font-display)">Home</div>
```

to:

```html
        <div class="text-5xl font-semibold text-[var(--c-text-display)] mb-2">Home</div>
```

- [ ] **Step 3: Update `DesktopWidgets.vue`'s hero number**

In `apps/dashboard/src/components/desktop/DesktopWidgets.vue:38-41`, change:

```html
            <span
              class="text-4xl tabular-nums leading-none text-[var(--c-text-display)]"
              style="font-family: var(--font-display)"
            >{{ metrics?.cpu ?? '—' }}</span>
```

to:

```html
            <span
              class="text-4xl font-semibold tabular-nums leading-none text-[var(--c-text-display)]"
            >{{ metrics?.cpu ?? '—' }}</span>
```

- [ ] **Step 4: Update `DashboardPanel.vue`'s hero number**

In `apps/dashboard/src/components/dashboard/DashboardPanel.vue:110-113`, change:

```html
                <span
                  class="text-4xl tabular-nums leading-none text-[var(--c-text-display)]"
                  style="font-family: var(--font-display)"
                >{{ metrics?.cpu ?? '—' }}</span>
```

to:

```html
                <span
                  class="text-4xl font-semibold tabular-nums leading-none text-[var(--c-text-display)]"
                >{{ metrics?.cpu ?? '—' }}</span>
```

- [ ] **Step 5: Verify no remaining references**

Run: `grep -rn "font-display\|Doto" apps/dashboard/src`
Expected: no matches (the token and its only 3 consumers are all gone).

- [ ] **Step 6: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors.

- [ ] **Step 7: Manual check**

Open the login screen and confirm the "Home" wordmark now renders in Inter Semibold instead of the dot-matrix Doto font. Open the desktop dashboard widgets and the DashboardPanel overview and confirm their large numbers are Inter Semibold.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/style.css apps/dashboard/src/views/LoginView.vue apps/dashboard/src/components/desktop/DesktopWidgets.vue apps/dashboard/src/components/dashboard/DashboardPanel.vue
git commit -m "feat(design-system): remove Doto display font, use Inter Semibold for hero numbers"
```

---

### Task 6: Migrate hardcoded eyebrow-style labels to the `.eyebrow` class

**Files:**
- Modify: `apps/dashboard/src/components/OverviewSection.vue:169,205,231,250,265`
- Modify: `apps/dashboard/src/components/SystemSection.vue:365,372,379`

**Context:** These 8 lines hand-roll the exact same visual treatment `.eyebrow` now provides (`text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)]`) as inline Tailwind utilities instead of using the shared class, so they didn't pick up Task 4's typography change. Fix: replace the inline utility string with the shared `.eyebrow` class plus whatever spacing utility the line already had.

**Interfaces:**
- Consumes: `.eyebrow` class from Task 4.

- [ ] **Step 1: Migrate the 5 section labels in `OverviewSection.vue`**

Change each of these 5 lines (verbatim, one per section: System, Storage, Containers, LVM, Recent Activity):

```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-3">System</div>
```
```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-3">Storage</div>
```
```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-3">Containers</div>
```
```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-3">LVM</div>
```
```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-3">Recent Activity</div>
```

to:

```html
          <div class="eyebrow mb-3">System</div>
```
```html
          <div class="eyebrow mb-3">Storage</div>
```
```html
          <div class="eyebrow mb-3">Containers</div>
```
```html
          <div class="eyebrow mb-3">LVM</div>
```
```html
          <div class="eyebrow mb-3">Recent Activity</div>
```

- [ ] **Step 2: Migrate the 3 chart labels in `SystemSection.vue`**

Change each of these 3 lines:

```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-2">CPU %</div>
```
```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-2">RAM (GB)</div>
```
```html
          <div class="text-[10px] font-mono uppercase tracking-widest text-[var(--c-text-3)] mb-2">Network (MB/s)</div>
```

to:

```html
          <div class="eyebrow mb-2">CPU %</div>
```
```html
          <div class="eyebrow mb-2">RAM (GB)</div>
```
```html
          <div class="eyebrow mb-2">Network (MB/s)</div>
```

Do **not** touch `SystemSection.vue`'s `Hostname`/`Architecture`/`Kernel` labels (they already use `text-[10px] uppercase tracking-wider text-[var(--c-text-3)]` without `font-mono` — already Inter, out of scope for this task) or any `font-mono` used on actual data values (e.g. the `fstype` badges in storage components) — those are technical data values and must stay in Space Mono per the design spec.

- [ ] **Step 3: Verify no remaining ad-hoc eyebrow duplicates**

Run: `grep -rn "font-mono uppercase tracking-widest" apps/dashboard/src/components/OverviewSection.vue apps/dashboard/src/components/SystemSection.vue`
Expected: no matches.

- [ ] **Step 4: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors.

- [ ] **Step 5: Manual check**

Open Monitor → Overview and Monitor → System. Confirm all 8 section labels render identically to other `.eyebrow` labels elsewhere in the app (Inter, small-caps style, `--c-text-3`), and that the `fstype` badges in Storage → Disks/Mounts/LVM are still shown in Space Mono (unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/OverviewSection.vue apps/dashboard/src/components/SystemSection.vue
git commit -m "fix(design-system): migrate hardcoded eyebrow labels to shared .eyebrow class"
```

---

### Task 7: Apply the new shadow token to modals

**Files:**
- Modify: `apps/dashboard/src/components/ui/Modal.vue`
- Modify: `apps/dashboard/src/components/storage/MountsSection.vue` (3 occurrences)
- Modify: `apps/dashboard/src/components/storage/LvmSection.vue` (8 occurrences)
- Modify: `apps/dashboard/src/components/storage/PhysicalDisksSection.vue` (6 occurrences)
- Modify: `apps/dashboard/src/components/storage/RaidSection.vue` (6 occurrences)
- Modify: `apps/dashboard/src/components/apps/ContainerLogsPanel.vue` (1 occurrence)

**Context:** The shared `Modal.vue` component's panel currently has no shadow at all. Five other components hand-roll their own modal/wizard dialogs (confirm dialogs, format wizards) using Tailwind's `rounded-2xl shadow-2xl` directly instead of the shared component. `rounded-2xl` is already `1rem`, exactly matching the new `--radius-xl` token, so it needs no change — only the shadow needs replacing: `shadow-2xl` is a much heavier drop shadow than the new subtle `--shadow-md` token calls for, and it is the exact string used in all 24 occurrences across these 5 files (confirmed via `grep -rn "shadow-2xl" apps/dashboard/src/components --include="*.vue"` — no other unrelated usage exists), so a literal find-replace is safe.

**Interfaces:**
- Consumes: `--shadow-md` from Task 1.

- [ ] **Step 1: Add shadow to the shared `Modal.vue` panel**

In `apps/dashboard/src/components/ui/Modal.vue`, change:

```html
      <div :class="['bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl flex flex-col max-h-[90vh]', panelClass]">
```

to:

```html
      <div :class="['bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-[var(--shadow-md)] flex flex-col max-h-[90vh]', panelClass]">
```

- [ ] **Step 2: Replace `shadow-2xl` with the token in the 5 hand-rolled dialog files**

Run this exact command (safe: `shadow-2xl` occurs 24 times total across exactly these 5 files and nowhere else in the codebase, all as part of modal/dialog container `class` attributes):

```bash
cd apps/dashboard/src/components
sed -i 's/shadow-2xl/shadow-[var(--shadow-md)]/g' storage/MountsSection.vue storage/LvmSection.vue storage/PhysicalDisksSection.vue storage/RaidSection.vue apps/ContainerLogsPanel.vue
```

- [ ] **Step 3: Verify the replacement**

Run: `grep -rn "shadow-2xl" apps/dashboard/src/components`
Expected: no matches.

Run: `grep -rn "shadow-\[var(--shadow-md)\]" apps/dashboard/src/components | wc -l`
Expected: `25` (24 replaced occurrences + the 1 added in `Modal.vue`).

- [ ] **Step 4: Type-check**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: 0 errors.

- [ ] **Step 5: Manual check**

Open a dialog through the shared `Modal.vue` (e.g. Files → file properties) and a hand-rolled storage wizard dialog (e.g. Storage → Disks → Format a partition, or Storage → RAID → destroy-array confirm). Confirm both show a visibly softer, more subtle shadow than before (previously `shadow-2xl` was a very heavy drop shadow) while keeping the same rounded corners.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/ui/Modal.vue apps/dashboard/src/components/storage/MountsSection.vue apps/dashboard/src/components/storage/LvmSection.vue apps/dashboard/src/components/storage/PhysicalDisksSection.vue apps/dashboard/src/components/storage/RaidSection.vue apps/dashboard/src/components/apps/ContainerLogsPanel.vue
git commit -m "feat(design-system): apply subtle shadow token to modals and dialogs"
```

---

## Verification (whole branch)

- `cd apps/dashboard && pnpm exec vue-tsc -b` → 0 errors.
- `grep -rn "font-display\|Doto" apps/dashboard/src` → no matches.
- `grep -rn "shadow-2xl" apps/dashboard/src` → no matches.
- Visual pass in both light and dark mode across: Settings (buttons, badges, inputs), Storage (cards, wizard dialogs), Monitor → Overview/System (migrated eyebrow labels), Login screen (hero wordmark), a danger action with a non-red accent selected (danger button/badge stays red).
