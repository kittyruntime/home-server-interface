# Desktop Mode (DSM-style windowing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional "desktop mode" to `apps/dashboard` that renders the four existing sections (Overview, Files, Apps, Settings) as draggable/resizable windows on a desktop canvas, with the sidebar becoming a dock of open windows and a Launchpad overlay for launching apps — without touching today's fullscreen mode.

**Architecture:** A new module-singleton composable `useDesktop()` (mirroring the existing `useAuth()`/`useUploads()` pattern) owns window state (`DesktopWindow[]`, persisted to `localStorage`) and a `desktopMode` preference. Four new presentational components (`DesktopShell`, `DesktopWindow`, `Dock`, `Launchpad`) consume that composable. `DashboardLayout.vue` branches between today's markup and the new desktop components based on `desktopMode && !isMobile`; the four existing panel components (`DashboardPanel`, `FileBrowserPanel`, `AppsPanel`, `SettingsPanel`) are wrapped unmodified inside `DesktopWindow.vue`.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Tailwind v4 (`@layer components` tokens already in `style.css`), hand-rolled Pointer Events drag/resize (no new dependency).

## Global Constraints

- No `box-shadow`, no `backdrop-blur` anywhere — elevation is border-color only (`var(--c-border-strong)` normal / `var(--c-accent)` focused), per the established Nothing-design system.
- No state library (Pinia/Vuex) — follow the existing plain-`ref()`-at-module-scope singleton pattern used by `useAuth()`/`useUploads()`/`useNotifications()`.
- No new npm dependency.
- This codebase has no test framework (confirmed: `apps/dashboard/package.json` has no `test` script, no vitest/jest, zero `.test.`/`.spec.` files anywhere). Verification for every task is `pnpm exec vue-tsc -b` + `pnpm exec vite build` (run from `apps/dashboard`) plus a manual functional check — do not introduce a test framework as a side effect of this plan.
- Commit only when explicitly instructed by the user; the "Step N: Commit" entries below describe what *would* be committed and are to be executed by whichever execution skill runs this plan, following that skill's own commit cadence.
- Existing fullscreen mode, its components, and its `localStorage` data are never modified or migrated.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/dashboard/src/lib/desktop.ts` (new) | Types (`AppId`, `DesktopWindow`), shared `APP_LABEL`/`APP_ICON_PATH` lookup tables, `localStorage` persistence, the `useDesktop()` singleton composable (open/close/focus/minimize/maximize/move/resize/clamp + the `desktopMode` flag). |
| `apps/dashboard/src/components/desktop/DesktopWindow.vue` (new) | One window: title bar (icon, label, minimize/maximize/close buttons, the `apps`-only "+" button), drag/resize via Pointer Events, renders the matching existing panel component in its body. |
| `apps/dashboard/src/components/desktop/Dock.vue` (new) | Replaces the sidebar's brand-mark+nav block in desktop mode: Launchpad-opening icon at top, one icon per currently-open window below. |
| `apps/dashboard/src/components/desktop/Launchpad.vue` (new) | Fullscreen `Teleport` overlay, 4-icon grid (always all 4 apps), click opens an app and closes the overlay; Escape/backdrop-click closes without opening anything. |
| `apps/dashboard/src/components/desktop/DesktopShell.vue` (new) | Replaces the `<main>` content area in desktop mode: tracks its own bounding box, re-clamps windows into it on mount/resize, renders one `<DesktopWindow>` per non-minimized window in `zIndex` order. |
| `apps/dashboard/src/views/DashboardLayout.vue` (modify) | Adds the `desktopMode` toggle to the user dropdown, a reactive `isMobile` flag, branches the `<aside>` nav block to `<Dock>` and the `<main>` content to `<DesktopShell>` when active, renders `<Launchpad>`, routes `goToProfile()` through `openApp('settings', 'profile')` in desktop mode. |

---

### Task 1: `lib/desktop.ts` — types, persistence, `useDesktop()` composable

**Files:**
- Create: `apps/dashboard/src/lib/desktop.ts`

**Interfaces:**
- Produces: `AppId`, `SettingsSection`, `DesktopWindow`, `APP_LABEL: Record<AppId, string>`, `APP_ICON_PATH: Record<AppId, string>`, `useDesktop()` returning `{ windows: Ref<DesktopWindow[]>, desktopMode: Ref<boolean>, setDesktopMode(v: boolean): void, openApp(appId: AppId, focusSection?: SettingsSection): void, closeWindow(id: string): void, focusWindow(id: string): void, toggleMinimize(id: string): void, toggleMaximize(id: string, bounds: { w: number; h: number }): void, moveWindow(id: string, x: number, y: number): void, resizeWindow(id: string, w: number, h: number): void, clampToViewport(bounds: { w: number; h: number }): void }`.

- [ ] **Step 1: Write `apps/dashboard/src/lib/desktop.ts`**

```ts
import { ref } from 'vue'

export type AppId = 'dashboard' | 'files' | 'apps' | 'settings'
export type SettingsSection = 'profile' | 'users' | 'places' | 'roles' | 'updates'

export interface DesktopWindow {
  id: string
  appId: AppId
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  prevRect?: { x: number; y: number; w: number; h: number }
  zIndex: number
  focusSection?: SettingsSection
}

export const APP_LABEL: Record<AppId, string> = {
  dashboard: 'Overview',
  files: 'Files',
  apps: 'Apps',
  settings: 'Settings',
}

export const APP_ICON_PATH: Record<AppId, string> = {
  dashboard: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z',
  files: 'M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  apps: 'M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
}

const STORAGE_KEY = 'desktop'
const MODE_KEY = 'desktopMode'
const MULTI_INSTANCE = new Set<AppId>(['files'])
const MIN_W = 320
const MIN_H = 240
const MIN_VISIBLE = 80

const DEFAULT_SIZE: Record<AppId, { w: number; h: number }> = {
  dashboard: { w: 720, h: 520 },
  files: { w: 860, h: 560 },
  apps: { w: 760, h: 540 },
  settings: { w: 860, h: 560 },
}

function loadWindows(): DesktopWindow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as DesktopWindow[]
    }
  } catch { /* ignore */ }
  return []
}

function saveWindows(ws: DesktopWindow[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ws))
}

function loadDesktopMode(): boolean {
  return localStorage.getItem(MODE_KEY) === '1'
}

function saveDesktopMode(v: boolean) {
  localStorage.setItem(MODE_KEY, v ? '1' : '0')
}

const windows = ref<DesktopWindow[]>(loadWindows())
const desktopMode = ref<boolean>(loadDesktopMode())

function persist() {
  saveWindows(windows.value)
}

function nextZIndex(): number {
  return windows.value.reduce((max, w) => Math.max(max, w.zIndex), 0) + 1
}

function cascadeOffset(): { x: number; y: number } {
  const step = (windows.value.length * 24) % 240
  return { x: 48 + step, y: 48 + step }
}

function clampWindow(w: DesktopWindow, bounds: { w: number; h: number }) {
  if (w.maximized) {
    w.x = 0
    w.y = 0
    w.w = bounds.w
    w.h = bounds.h
    return
  }
  w.w = Math.min(w.w, Math.max(bounds.w, MIN_W))
  w.h = Math.min(w.h, Math.max(bounds.h, MIN_H))
  w.x = Math.min(Math.max(w.x, -(w.w - MIN_VISIBLE)), Math.max(0, bounds.w - MIN_VISIBLE))
  w.y = Math.min(Math.max(w.y, 0), Math.max(0, bounds.h - MIN_VISIBLE))
}

export function useDesktop() {
  function openApp(appId: AppId, focusSection?: SettingsSection) {
    if (!MULTI_INSTANCE.has(appId)) {
      const existing = windows.value.find(w => w.appId === appId)
      if (existing) {
        if (focusSection !== undefined) existing.focusSection = focusSection
        focusWindow(existing.id)
        return
      }
    }
    const size = DEFAULT_SIZE[appId]
    const { x, y } = cascadeOffset()
    const win: DesktopWindow = {
      id: crypto.randomUUID(),
      appId,
      x,
      y,
      w: size.w,
      h: size.h,
      minimized: false,
      maximized: false,
      zIndex: nextZIndex(),
      focusSection,
    }
    windows.value.push(win)
    persist()
  }

  function closeWindow(id: string) {
    windows.value = windows.value.filter(w => w.id !== id)
    persist()
  }

  function focusWindow(id: string) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    w.minimized = false
    w.zIndex = nextZIndex()
    persist()
  }

  function toggleMinimize(id: string) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    w.minimized = !w.minimized
    persist()
  }

  function toggleMaximize(id: string, bounds: { w: number; h: number }) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    if (w.maximized) {
      if (w.prevRect) {
        w.x = w.prevRect.x
        w.y = w.prevRect.y
        w.w = w.prevRect.w
        w.h = w.prevRect.h
      }
      w.maximized = false
      w.prevRect = undefined
    } else {
      w.prevRect = { x: w.x, y: w.y, w: w.w, h: w.h }
      w.x = 0
      w.y = 0
      w.w = bounds.w
      w.h = bounds.h
      w.maximized = true
    }
    persist()
  }

  function moveWindow(id: string, x: number, y: number) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    w.x = x
    w.y = y
    persist()
  }

  function resizeWindow(id: string, w: number, h: number) {
    const win = windows.value.find(win => win.id === id)
    if (!win) return
    win.w = Math.max(MIN_W, w)
    win.h = Math.max(MIN_H, h)
    persist()
  }

  function clampToViewport(bounds: { w: number; h: number }) {
    for (const w of windows.value) clampWindow(w, bounds)
    persist()
  }

  function setDesktopMode(v: boolean) {
    desktopMode.value = v
    saveDesktopMode(v)
  }

  return {
    windows,
    desktopMode,
    setDesktopMode,
    openApp,
    closeWindow,
    focusWindow,
    toggleMinimize,
    toggleMaximize,
    moveWindow,
    resizeWindow,
    clampToViewport,
  }
}
```

- [ ] **Step 2: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors (this file isn't imported anywhere yet, but `tsconfig.app.json`'s `include: ["src/**/*.ts", ...]` typechecks it regardless).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/desktop.ts
git commit -m "feat(dashboard): add useDesktop window-manager composable"
```

---

### Task 2: `components/desktop/DesktopWindow.vue`

**Files:**
- Create: `apps/dashboard/src/components/desktop/DesktopWindow.vue`

**Interfaces:**
- Consumes: `useDesktop()` (Task 1) for `closeWindow`/`focusWindow`/`toggleMinimize`/`toggleMaximize`/`moveWindow`/`resizeWindow`; `APP_LABEL`/`APP_ICON_PATH` (Task 1); `useAuth()` (`isAdmin`) from existing `lib/auth.ts`; the four existing panel components.
- Produces: `<DesktopWindow :win="DesktopWindow" :focused="boolean" :bounds="{ w: number; h: number }" />` — a self-contained window with no emitted events (all interaction goes straight through `useDesktop()`).

- [ ] **Step 1: Write `apps/dashboard/src/components/desktop/DesktopWindow.vue`**

```vue
<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type DesktopWindow } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import DashboardPanel from '../dashboard/DashboardPanel.vue'
import FileBrowserPanel from '../file-browser/FileBrowserPanel.vue'
import AppsPanel from '../apps/AppsPanel.vue'
import SettingsPanel from '../SettingsPanel.vue'

const props = defineProps<{
  win: DesktopWindow
  focused: boolean
  bounds: { w: number; h: number }
}>()

const { closeWindow, focusWindow, toggleMinimize, toggleMaximize, moveWindow, resizeWindow } = useDesktop()
const { isAdmin } = useAuth()

const appsPanelRef = ref<InstanceType<typeof AppsPanel> | null>(null)

type DragState = { px: number; py: number; wx: number; wy: number }
type ResizeState = { px: number; py: number; ww: number; wh: number; wx: number; wy: number; edge: string }

let dragState: DragState | null = null
let resizeState: ResizeState | null = null

function startDrag(e: PointerEvent) {
  if (props.win.maximized) return
  focusWindow(props.win.id)
  dragState = { px: e.clientX, py: e.clientY, wx: props.win.x, wy: props.win.y }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
}

function onDragMove(e: PointerEvent) {
  if (!dragState) return
  const dx = e.clientX - dragState.px
  const dy = e.clientY - dragState.py
  const minVisible = 80
  const nx = Math.min(Math.max(dragState.wx + dx, -(props.win.w - minVisible)), Math.max(0, props.bounds.w - minVisible))
  const ny = Math.min(Math.max(dragState.wy + dy, 0), Math.max(0, props.bounds.h - 40))
  moveWindow(props.win.id, nx, ny)
}

function onDragEnd() {
  dragState = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
}

function startResize(e: PointerEvent, edge: string) {
  if (props.win.maximized) return
  focusWindow(props.win.id)
  resizeState = { px: e.clientX, py: e.clientY, ww: props.win.w, wh: props.win.h, wx: props.win.x, wy: props.win.y, edge }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
}

function onResizeMove(e: PointerEvent) {
  if (!resizeState) return
  const { px, py, ww, wh, wx, wy, edge } = resizeState
  const dx = e.clientX - px
  const dy = e.clientY - py
  let w = ww, h = wh, x = wx, y = wy
  if (edge.includes('e')) w = ww + dx
  if (edge.includes('s')) h = wh + dy
  if (edge.includes('w')) { w = ww - dx; x = wx + dx }
  if (edge.includes('n')) { h = wh - dy; y = wy + dy }
  if (w < 320) { if (edge.includes('w')) x = wx + (ww - 320); w = 320 }
  if (h < 240) { if (edge.includes('n')) y = wy + (wh - 240); h = 240 }
  resizeWindow(props.win.id, w, h)
  if (edge.includes('w') || edge.includes('n')) moveWindow(props.win.id, x, y)
}

function onResizeEnd() {
  resizeState = null
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
}

onUnmounted(() => {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
})

function onMaximizeClick() {
  toggleMaximize(props.win.id, props.bounds)
}
</script>

<template>
  <div
    class="absolute flex flex-col rounded-xl overflow-hidden bg-[var(--c-surface)] border"
    :class="focused ? 'border-[var(--c-accent)]' : 'border-[var(--c-border-strong)]'"
    :style="{ left: win.x + 'px', top: win.y + 'px', width: win.w + 'px', height: win.h + 'px', zIndex: win.zIndex }"
    @pointerdown="focusWindow(win.id)"
  >
    <div
      class="h-9 flex items-center justify-between px-3 border-b border-[var(--c-border)] bg-[var(--c-surface-alt)] flex-shrink-0 select-none cursor-default"
      @pointerdown="startDrag"
      @dblclick="onMaximizeClick"
    >
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[win.appId]"/>
        </svg>
        <span class="eyebrow truncate">{{ APP_LABEL[win.appId] }}</span>
      </div>
      <div class="flex items-center gap-3 shrink-0" @pointerdown.stop>
        <button
          v-if="win.appId === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          title="New App"
          class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-accent)] transition-colors"
        >[+]</button>
        <button @click="toggleMinimize(win.id)" title="Minimize" class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">[_]</button>
        <button @click="onMaximizeClick" title="Maximize" class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">[{{ win.maximized ? '❐' : '□' }}]</button>
        <button @click="closeWindow(win.id)" title="Close" class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-accent)] transition-colors">[X]</button>
      </div>
    </div>

    <div class="flex-1 overflow-hidden">
      <DashboardPanel v-if="win.appId === 'dashboard'" class="h-full" />
      <FileBrowserPanel v-else-if="win.appId === 'files'" class="h-full" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" class="h-full" :focusSection="win.focusSection ?? null" />
    </div>

    <template v-if="!win.maximized">
      <div class="absolute top-0 left-1.5 right-1.5 h-1 cursor-ns-resize" @pointerdown.stop="startResize($event, 'n')" />
      <div class="absolute bottom-0 left-1.5 right-1.5 h-1 cursor-ns-resize" @pointerdown.stop="startResize($event, 's')" />
      <div class="absolute left-0 top-1.5 bottom-1.5 w-1 cursor-ew-resize" @pointerdown.stop="startResize($event, 'w')" />
      <div class="absolute right-0 top-1.5 bottom-1.5 w-1 cursor-ew-resize" @pointerdown.stop="startResize($event, 'e')" />
      <div class="absolute top-0 left-0 w-2 h-2 cursor-nwse-resize" @pointerdown.stop="startResize($event, 'nw')" />
      <div class="absolute top-0 right-0 w-2 h-2 cursor-nesw-resize" @pointerdown.stop="startResize($event, 'ne')" />
      <div class="absolute bottom-0 left-0 w-2 h-2 cursor-nesw-resize" @pointerdown.stop="startResize($event, 'sw')" />
      <div class="absolute bottom-0 right-0 w-2 h-2 cursor-nwse-resize" @pointerdown.stop="startResize($event, 'se')" />
    </template>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/DesktopWindow.vue
git commit -m "feat(dashboard): add DesktopWindow component (drag/resize/min/max/close)"
```

---

### Task 3: `components/desktop/Dock.vue`

**Files:**
- Create: `apps/dashboard/src/components/desktop/Dock.vue`

**Interfaces:**
- Consumes: `useDesktop()` for `windows`/`focusWindow`/`toggleMinimize`; `APP_LABEL`/`APP_ICON_PATH` (Task 1).
- Produces: `<Dock @open-launchpad="..." />`, emits `openLaunchpad: []`.

- [ ] **Step 1: Write `apps/dashboard/src/components/desktop/Dock.vue`**

```vue
<script setup lang="ts">
import { useDesktop, APP_LABEL, APP_ICON_PATH } from '../../lib/desktop'

const { windows, focusWindow, toggleMinimize } = useDesktop()

defineEmits<{ openLaunchpad: [] }>()

function isFocused(id: string): boolean {
  if (windows.value.length === 0) return false
  const maxZ = Math.max(...windows.value.map(w => w.zIndex))
  const w = windows.value.find(w => w.id === id)
  return !!w && w.zIndex === maxZ && !w.minimized
}

function onIconClick(id: string) {
  const w = windows.value.find(w => w.id === id)
  if (!w) return
  if (w.minimized) {
    focusWindow(id)
  } else if (isFocused(id)) {
    toggleMinimize(id)
  } else {
    focusWindow(id)
  }
}
</script>

<template>
  <div class="flex flex-col items-center w-16 py-4 h-full">
    <button
      @click="$emit('openLaunchpad')"
      title="Launchpad"
      class="w-8 h-8 rounded-lg bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] mb-5 select-none"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
      </svg>
    </button>

    <div class="w-8 border-t border-[var(--c-border)] mb-3" />

    <nav class="flex flex-col items-stretch gap-1 flex-1 w-full overflow-y-auto">
      <div v-for="w in windows" :key="w.id" class="relative flex justify-center py-0.5">
        <span
          v-if="isFocused(w.id)"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
        />
        <button
          @click="onIconClick(w.id)"
          :title="APP_LABEL[w.appId]"
          :class="[
            'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
            w.minimized ? 'opacity-40' : '',
            isFocused(w.id)
              ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
              : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
          ]"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[w.appId]"/>
          </svg>
        </button>
      </div>
    </nav>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/Dock.vue
git commit -m "feat(dashboard): add Dock component for open desktop windows"
```

---

### Task 4: `components/desktop/Launchpad.vue`

**Files:**
- Create: `apps/dashboard/src/components/desktop/Launchpad.vue`

**Interfaces:**
- Consumes: `useDesktop()` for `openApp`; `APP_LABEL`/`APP_ICON_PATH` (Task 1).
- Produces: `<Launchpad @close="..." />`, emits `close: []`.

- [ ] **Step 1: Write `apps/dashboard/src/components/desktop/Launchpad.vue`**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type AppId } from '../../lib/desktop'

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()

const APP_IDS: AppId[] = ['dashboard', 'files', 'apps', 'settings']

function launch(id: AppId) {
  openApp(id)
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 bg-[var(--c-bg)] flex items-center justify-center"
      @click.self="emit('close')"
    >
      <div class="grid grid-cols-4 gap-8 p-8">
        <button
          v-for="id in APP_IDS"
          :key="id"
          @click="launch(id)"
          class="flex flex-col items-center gap-3 p-4 rounded-2xl hover:bg-[var(--c-hover)] transition-colors"
        >
          <div class="w-16 h-16 rounded-2xl bg-[var(--c-surface)] border border-[var(--c-border-strong)] flex items-center justify-center text-[var(--c-text-2)]">
            <svg class="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[id]"/>
            </svg>
          </div>
          <span class="eyebrow">{{ APP_LABEL[id] }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 2: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/Launchpad.vue
git commit -m "feat(dashboard): add Launchpad overlay for launching desktop apps"
```

---

### Task 5: `components/desktop/DesktopShell.vue`

**Files:**
- Create: `apps/dashboard/src/components/desktop/DesktopShell.vue`

**Interfaces:**
- Consumes: `useDesktop()` for `windows`/`clampToViewport` (Task 1); `DesktopWindow.vue` (Task 2).
- Produces: `<DesktopShell />` — no props, no emits, fills its parent container.

- [ ] **Step 1: Write `apps/dashboard/src/components/desktop/DesktopShell.vue`**

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDesktop } from '../../lib/desktop'
import DesktopWindow from './DesktopWindow.vue'

const { windows, clampToViewport } = useDesktop()

const rootRef = ref<HTMLDivElement | null>(null)
const bounds = ref({ w: 0, h: 0 })

function updateBounds() {
  if (!rootRef.value) return
  bounds.value = { w: rootRef.value.clientWidth, h: rootRef.value.clientHeight }
}

function onResize() {
  updateBounds()
  clampToViewport(bounds.value)
}

onMounted(() => {
  updateBounds()
  clampToViewport(bounds.value)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => window.removeEventListener('resize', onResize))

const visibleWindows = computed(() =>
  windows.value.filter(w => !w.minimized).slice().sort((a, b) => a.zIndex - b.zIndex)
)

function isFocused(id: string): boolean {
  const visible = windows.value.filter(w => !w.minimized)
  if (visible.length === 0) return false
  const maxZ = Math.max(...visible.map(w => w.zIndex))
  const w = windows.value.find(w => w.id === id)
  return !!w && w.zIndex === maxZ && !w.minimized
}
</script>

<template>
  <div ref="rootRef" class="relative w-full h-full overflow-hidden bg-[var(--c-bg)]">
    <DesktopWindow
      v-for="w in visibleWindows"
      :key="w.id"
      :win="w"
      :focused="isFocused(w.id)"
      :bounds="bounds"
    />
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/DesktopShell.vue
git commit -m "feat(dashboard): add DesktopShell window canvas"
```

---

### Task 6: Wire desktop mode into `DashboardLayout.vue`

**Files:**
- Modify: `apps/dashboard/src/views/DashboardLayout.vue`

**Interfaces:**
- Consumes: `useDesktop()` (Task 1), `Dock.vue` (Task 3), `Launchpad.vue` (Task 4), `DesktopShell.vue` (Task 5).
- Produces: a "Desktop mode" toggle in the user dropdown; `<aside>` and `<main>` branch on `desktopMode && !isMobile`.

- [ ] **Step 1: Add imports and composable wiring**

In `apps/dashboard/src/views/DashboardLayout.vue`, replace:

```ts
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'
import { useUploads } from '../lib/uploads'
import { useNotifications } from '../lib/notifications'
import { trpc } from '../lib/trpc'
import SettingsPanel from '../components/SettingsPanel.vue'
import FileBrowserPanel from '../components/file-browser/FileBrowserPanel.vue'
import AppsPanel from '../components/apps/AppsPanel.vue'
import DashboardPanel from '../components/dashboard/DashboardPanel.vue'
import NotificationsContainer from '../components/NotificationsContainer.vue'
import NotificationMenu from '../components/NotificationMenu.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
```

with:

```ts
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'
import { useUploads } from '../lib/uploads'
import { useNotifications } from '../lib/notifications'
import { useDesktop } from '../lib/desktop'
import { trpc } from '../lib/trpc'
import SettingsPanel from '../components/SettingsPanel.vue'
import FileBrowserPanel from '../components/file-browser/FileBrowserPanel.vue'
import AppsPanel from '../components/apps/AppsPanel.vue'
import DashboardPanel from '../components/dashboard/DashboardPanel.vue'
import NotificationsContainer from '../components/NotificationsContainer.vue'
import NotificationMenu from '../components/NotificationMenu.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import Dock from '../components/desktop/Dock.vue'
import Launchpad from '../components/desktop/Launchpad.vue'
import DesktopShell from '../components/desktop/DesktopShell.vue'
```

- [ ] **Step 2: Add `isMobile`, `launchpadOpen`, and `useDesktop()` state**

Replace:

```ts
const router = useRouter()
const { currentUsername, isAdmin, logout } = useAuth()
const uploads = useUploads()
const { notifications } = useNotifications()
```

with:

```ts
const router = useRouter()
const { currentUsername, isAdmin, logout } = useAuth()
const uploads = useUploads()
const { notifications } = useNotifications()
const { desktopMode, setDesktopMode, openApp } = useDesktop()

const isMobile = ref(window.innerWidth < 640)
const launchpadOpen = ref(false)

function updateIsMobile() {
  isMobile.value = window.innerWidth < 640
}
```

- [ ] **Step 3: Register/unregister the mobile-width resize listener**

Replace:

```ts
onMounted(() => {
  document.addEventListener('click', closeUserMenu)
  checkUpdateBadge()
  updateTimer = setInterval(checkUpdateBadge, 3_600_000) // hourly
})
onUnmounted(() => {
  document.removeEventListener('click', closeUserMenu)
  clearInterval(updateTimer)
})
```

with:

```ts
onMounted(() => {
  document.addEventListener('click', closeUserMenu)
  window.addEventListener('resize', updateIsMobile)
  checkUpdateBadge()
  updateTimer = setInterval(checkUpdateBadge, 3_600_000) // hourly
})
onUnmounted(() => {
  document.removeEventListener('click', closeUserMenu)
  window.removeEventListener('resize', updateIsMobile)
  clearInterval(updateTimer)
})
```

- [ ] **Step 4: Route `goToProfile()` through `openApp` in desktop mode**

Replace:

```ts
function goToProfile() {
  activeApp.value = 'settings'
  settingsSection.value = 'profile'
  userMenuOpen.value = false
}
```

with:

```ts
function goToProfile() {
  if (desktopMode.value && !isMobile.value) {
    openApp('settings', 'profile')
  } else {
    activeApp.value = 'settings'
    settingsSection.value = 'profile'
  }
  userMenuOpen.value = false
}
```

- [ ] **Step 5: Branch the `<aside>` nav block to `<Dock>`**

Replace the opening of the `<aside>` block (from the `<!-- Brand mark -->` comment through the end of the `</nav>` closing tag, i.e. everything between `<aside ...>` and the `<!-- Notifications bell -->` comment):

```html
      <!-- Brand mark -->
      <div class="w-8 h-8 rounded-lg bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] mb-5 select-none">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </div>

      <div class="w-8 border-t border-[var(--c-border)] mb-3" />

      <!-- App nav -->
      <nav class="flex flex-col items-stretch gap-1 flex-1 w-full">
```

with:

```html
      <template v-if="desktopMode && !isMobile">
        <Dock class="flex-1" @open-launchpad="launchpadOpen = true" />
      </template>
      <template v-else>
        <!-- Brand mark -->
        <div class="w-8 h-8 rounded-lg bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] mb-5 select-none">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </div>

        <div class="w-8 border-t border-[var(--c-border)] mb-3" />

        <!-- App nav -->
        <nav class="flex flex-col items-stretch gap-1 flex-1 w-full">
```

Leave the rest of the four nav-icon `<div>` blocks (Dashboard/Files/Apps/Settings) exactly as-is, and change the existing closing:

```html
      </nav>
```

(the one right before `<!-- Notifications bell -->`) to:

```html
      </nav>
      </template>
```

- [ ] **Step 6: Branch the `<main>` content to `<DesktopShell>`**

Replace:

```html
    <!-- Main area -->
    <main class="flex-1 flex flex-col overflow-hidden">

      <!-- Top bar (hidden for files — FileToolbar acts as the header) -->
      <header v-if="activeApp !== 'files'" class="h-11 flex items-center justify-between px-6 border-b border-[var(--c-border)] flex-shrink-0 bg-[var(--c-surface-alt)]">
        <span class="eyebrow">{{ activeAppLabel }}</span>
        <button
          v-if="activeApp === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          class="btn btn-primary btn-xs"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          New App
        </button>
      </header>

      <!-- Content -->
      <div :class="['flex-1', activeApp !== 'dashboard' ? 'overflow-hidden' : 'overflow-auto']">
        <DashboardPanel v-if="activeApp === 'dashboard'" class="h-full" />
        <FileBrowserPanel v-else-if="activeApp === 'files'" class="h-full" />
        <AppsPanel v-else-if="activeApp === 'apps'" ref="appsPanelRef" class="h-full" />
        <SettingsPanel v-else-if="activeApp === 'settings'" class="h-full" :focusSection="settingsSection" />
        <div v-else class="flex items-center justify-center h-full text-[var(--c-text-3)] select-none">
          <div class="text-center space-y-3">
            <svg class="w-12 h-12 mx-auto opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
            <p class="text-sm">Select an app from the sidebar</p>
          </div>
        </div>
      </div>

    </main>
```

with:

```html
    <!-- Main area -->
    <main class="flex-1 flex flex-col overflow-hidden">
      <DesktopShell v-if="desktopMode && !isMobile" />
      <template v-else>
        <!-- Top bar (hidden for files — FileToolbar acts as the header) -->
        <header v-if="activeApp !== 'files'" class="h-11 flex items-center justify-between px-6 border-b border-[var(--c-border)] flex-shrink-0 bg-[var(--c-surface-alt)]">
          <span class="eyebrow">{{ activeAppLabel }}</span>
          <button
            v-if="activeApp === 'apps' && isAdmin"
            @click="appsPanelRef?.openNew()"
            class="btn btn-primary btn-xs"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            New App
          </button>
        </header>

        <!-- Content -->
        <div :class="['flex-1', activeApp !== 'dashboard' ? 'overflow-hidden' : 'overflow-auto']">
          <DashboardPanel v-if="activeApp === 'dashboard'" class="h-full" />
          <FileBrowserPanel v-else-if="activeApp === 'files'" class="h-full" />
          <AppsPanel v-else-if="activeApp === 'apps'" ref="appsPanelRef" class="h-full" />
          <SettingsPanel v-else-if="activeApp === 'settings'" class="h-full" :focusSection="settingsSection" />
          <div v-else class="flex items-center justify-center h-full text-[var(--c-text-3)] select-none">
            <div class="text-center space-y-3">
              <svg class="w-12 h-12 mx-auto opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              <p class="text-sm">Select an app from the sidebar</p>
            </div>
          </div>
        </div>
      </template>
    </main>
```

- [ ] **Step 7: Add the "Desktop mode" toggle to the user dropdown**

Replace:

```html
          <div class="p-1.5">
            <button
              @click="goToProfile"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--c-text-2)]
                     hover:bg-[var(--c-hover)] rounded-lg transition-colors text-left"
            >
              <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              Profile
            </button>
            <div class="h-px bg-[var(--c-border-strong)] mx-1 my-1" />
            <button
              @click="handleLogout"
```

with:

```html
          <div class="p-1.5">
            <button
              @click="goToProfile"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--c-text-2)]
                     hover:bg-[var(--c-hover)] rounded-lg transition-colors text-left"
            >
              <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              Profile
            </button>
            <div class="h-px bg-[var(--c-border-strong)] mx-1 my-1" />
            <div class="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-sm text-[var(--c-text-2)]">
              <span class="flex items-center gap-2.5">
                <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
                Desktop mode
              </span>
              <button
                @click="setDesktopMode(!desktopMode)"
                role="switch"
                :aria-checked="desktopMode"
                title="Toggle desktop mode"
                :class="['relative w-8 h-4.5 rounded-full transition-colors shrink-0', desktopMode ? 'bg-[var(--c-accent)]' : 'bg-[var(--c-border-strong)]']"
              >
                <span :class="['absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform', desktopMode ? 'translate-x-[18px]' : 'translate-x-0.5']" />
              </button>
            </div>
            <div class="h-px bg-[var(--c-border-strong)] mx-1 my-1" />
            <button
              @click="handleLogout"
```

- [ ] **Step 8: Render `<Launchpad>` alongside the other global overlays**

Replace:

```html
  <NotificationsContainer />
  <ConfirmDialog />
  <NotificationMenu
    :open="notifMenuOpen"
    :pos="notifPos"
    @close="notifMenuOpen = false"
  />
</template>
```

with:

```html
  <NotificationsContainer />
  <ConfirmDialog />
  <NotificationMenu
    :open="notifMenuOpen"
    :pos="notifPos"
    @close="notifMenuOpen = false"
  />
  <Launchpad v-if="launchpadOpen" @close="launchpadOpen = false" />
</template>
```

- [ ] **Step 9: Typecheck and build**

Run from `apps/dashboard`:
```bash
pnpm exec vue-tsc -b
pnpm exec vite build
```
Expected: both succeed with no errors.

- [ ] **Step 10: Manual verification pass**

With the dashboard running (`pnpm dev`, logged in):
1. Open the user dropdown, flip "Desktop mode" on — sidebar nav becomes the Dock (just the Launchpad icon, empty otherwise), main area becomes an empty desktop canvas.
2. Click the Launchpad icon — overlay shows all 4 apps; click "Files" — overlay closes, a Files window opens.
3. Drag the Files window by its title bar; resize it from each edge/corner; minimize it (dock icon dims, window disappears); click its dock icon again (restores + focuses); maximize it (fills the canvas); maximize again (restores prior rect); close it (dock icon disappears).
4. Open Files again from the Launchpad twice in a row — confirm two separate cascaded Files windows both appear and both have dock icons (multi-instance).
5. Open Apps as an admin — confirm the `[+]` "New App" button appears in its title bar and opens the existing new-app modal.
6. Open the user dropdown → "Profile" — confirm a Settings window opens already on the Profile section.
7. Reload the page — confirm the same windows/positions restore.
8. Flip "Desktop mode" off — confirm today's fullscreen view is back and unaffected; flip it back on — confirm the desktop windows are still there.
9. Shrink the browser window with a window positioned near the right/bottom edge — confirm it gets re-clamped into view, not stranded off-screen.
10. Resize the browser below 640px width — confirm desktop mode is bypassed (today's fullscreen + bottom nav), regardless of the toggle's stored state.

- [ ] **Step 11: Commit**

```bash
git add apps/dashboard/src/views/DashboardLayout.vue
git commit -m "feat(dashboard): wire desktop mode toggle, Dock, and DesktopShell into DashboardLayout"
```

---

## Self-Review

**Spec coverage:**
- `desktopMode` preference + toggle in user dropdown → Task 6, Steps 2 & 7. ✓
- `useDesktop()` composable with all listed ops + persistence → Task 1. ✓
- `DesktopShell`/`DesktopWindow`/`Dock`/`Launchpad` → Tasks 2–5. ✓
- Four existing panels wired in unmodified → Task 2 (body switch), confirmed none of `DashboardPanel`/`FileBrowserPanel`/`AppsPanel`/`SettingsPanel` source files are touched anywhere in this plan. ✓
- Mobile always fullscreen regardless of preference → `isMobile` check in every branch (`desktopMode && !isMobile`), Task 6 Steps 2, 5, 6. ✓
- Multi-instance for Files only → `MULTI_INSTANCE` set in Task 1. ✓
- Drag/resize/minimize/maximize/close/focus → Task 2. ✓
- Launchpad always-4-icons, Escape/backdrop close → Task 4. ✓
- Dock shows only open windows, active/dim states → Task 3. ✓
- Viewport-shrink re-clamp → `clampToViewport` (Task 1) called on mount and `resize` in `DesktopShell.vue` (Task 5). ✓
- "New App" button gap → `[+]` button in `DesktopWindow.vue` title bar, Task 2. ✓
- "Profile" deep-link gap → `focusSection` field on `DesktopWindow` (Task 1) + `goToProfile()` routing (Task 6 Step 4) + `SettingsPanel`'s existing `focusSection` prop (unmodified, already watches for changes). ✓
- No box-shadow/blur → none used anywhere in Tasks 2–5; elevation is `border-[var(--c-accent)]` vs `border-[var(--c-border-strong)]` only. ✓
- `[X]`-style mono buttons → `[_]`/`[□]`/`[X]`/`[+]` in Task 2, matching `Modal.vue`'s convention. ✓

**Placeholder scan:** No "TBD"/"TODO"/"similar to Task N" found; every step has literal code or a literal shell command with expected output.

**Type consistency:** `DesktopWindow`, `AppId`, `SettingsSection` defined once in Task 1 and imported by name (not redefined) in Tasks 2–6. `useDesktop()`'s returned function names/signatures (`openApp(appId, focusSection?)`, `closeWindow(id)`, `focusWindow(id)`, `toggleMinimize(id)`, `toggleMaximize(id, bounds)`, `moveWindow(id, x, y)`, `resizeWindow(id, w, h)`, `clampToViewport(bounds)`, `setDesktopMode(v)`) are used identically in every consuming task. `SettingsPanel`'s pre-existing `focusSection?: SectionId | null` prop type is respected via `win.focusSection ?? null` in Task 2.
