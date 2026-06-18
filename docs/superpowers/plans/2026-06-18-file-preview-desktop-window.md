# File Preview as a Desktop Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When desktop mode is active, opening a file from a Files window produces a real
desktop window (drag/resize/minimize/maximize/Dock icon/persistence) instead of today's
`Modal.vue` overlay — fullscreen mode keeps the exact Modal-based behavior it has today.

**Architecture:** Extract the existing preview body (image/video/audio switch, async-loaded
CodeMirror editor, dirty/save tracking) out of `FilePreviewModal.vue` into a new
presentational `FilePreviewBody.vue`, reused by both the unchanged fullscreen `Modal.vue`
wrapper and a new `'file-preview'` window kind inside `DesktopWindow.vue`. The window
manager (`useDesktop()`) gets a path-keyed `openFilePreview()` entry point alongside the
existing appId-keyed `openApp()`.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript — no new dependency, no new pattern beyond
what `apps/dashboard/src/lib/desktop.ts` already established.

## Global Constraints

- No `box-shadow`, no `backdrop-blur` — match the existing border-only elevation convention.
- No state library — extend the existing `useDesktop()` module-singleton composable.
- No new npm dependency.
- No test framework exists in this repo. Verification for every task is `pnpm exec vue-tsc -b`
  + `pnpm exec vite build` (run from `apps/dashboard`), plus a manual check where noted — do
  not introduce a test framework as a side effect of this plan.
- Fullscreen mode's file-preview behavior (`FilePreviewModal.vue` wrapped in `Modal.vue`) must
  remain pixel-for-pixel behaviorally identical after the refactor in Task 1.
- Commit only when explicitly instructed by the user; the "Step N: Commit" entries describe
  what *would* be committed, executed by whichever execution skill runs this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/dashboard/src/components/file-browser/preview/FilePreviewBody.vue` (new) | Presentational: kind-switch (`MediaPreview`/async `CodeEditor`), dirty tracking, exposes `save()`. No Modal/window chrome. |
| `apps/dashboard/src/components/file-browser/preview/FilePreviewModal.vue` (modify) | Thin `Modal.vue` wrapper around `FilePreviewBody`, used only by fullscreen mode. |
| `apps/dashboard/src/lib/desktop.ts` (modify) | New `'file-preview'` `AppId` member, `FilePreviewPayload` type, `filePreview?` field on `DesktopWindow`, `MULTI_INSTANCE`/`DEFAULT_SIZE`/`APP_LABEL`/`APP_ICON_PATH` entries, `openFilePreview()`. |
| `apps/dashboard/src/components/desktop/DesktopWindow.vue` (modify) | New `file-preview` body case with its own title bar (filename, ext badge, download, unsaved dot) and dirty-aware close. |
| `apps/dashboard/src/components/desktop/Dock.vue` (modify) | Dock icon title shows the file's name instead of `APP_LABEL` for `file-preview` windows. |
| `apps/dashboard/src/components/file-browser/FileBrowserPanel.vue` (modify) | New `desktopWindow?: boolean` prop; `openFile()` routes to `openFilePreview()` when set. |

---

### Task 1: Extract `FilePreviewBody.vue` from `FilePreviewModal.vue`

**Files:**
- Create: `apps/dashboard/src/components/file-browser/preview/FilePreviewBody.vue`
- Modify: `apps/dashboard/src/components/file-browser/preview/FilePreviewModal.vue`

**Interfaces:**
- Produces: `<FilePreviewBody :entry="{ path: string; name: string; size: number | null }" />`,
  emits `dirty: [boolean]`, exposes `save(): void`.

- [ ] **Step 1: Write `apps/dashboard/src/components/file-browser/preview/FilePreviewBody.vue`**

```vue
<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from 'vue'
import MediaPreview from './MediaPreview.vue'
import { detectKind } from '../../../lib/file-kind'

type Entry = { path: string; name: string; size: number | null }

const props = defineProps<{ entry: Entry }>()
const emit = defineEmits<{ dirty: [boolean] }>()

const kind = computed(() => detectKind(props.entry.name))

// Code-split: CodeMirror only loads when a text file is actually opened.
const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'))

const editorRef = ref<{ save: () => void } | null>(null)

function save() {
  editorRef.value?.save()
}

defineExpose({ save })
</script>

<template>
  <MediaPreview v-if="kind === 'image' || kind === 'video' || kind === 'audio'" :path="entry.path" :kind="kind" />
  <CodeEditor
    v-else
    ref="editorRef"
    :path="entry.path"
    :name="entry.name"
    :size="entry.size"
    @dirty="emit('dirty', $event)"
  />
</template>
```

- [ ] **Step 2: Replace `apps/dashboard/src/components/file-browser/preview/FilePreviewModal.vue` in full**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import Modal from '../../ui/Modal.vue'
import FilePreviewBody from './FilePreviewBody.vue'
import { detectKind } from '../../../lib/file-kind'
import { useAuth } from '../../../lib/auth'
import { downloadUrl } from '../../../lib/file-url'

type Entry = { name: string; path: string; size: number | null }

const props = defineProps<{ entry: Entry }>()
const emit = defineEmits<{ close: [] }>()

const { token } = useAuth()
const kind = computed(() => detectKind(props.entry.name))
const ext = computed(() => props.entry.name.includes('.') ? props.entry.name.split('.').pop()!.toUpperCase() : '')

const bodyRef = ref<{ save: () => void } | null>(null)
const dirty = ref(false)

function tryClose() {
  if (dirty.value && !confirm('Discard unsaved changes?')) return
  emit('close')
}
</script>

<template>
  <Modal panel-class="w-[92vw] h-[88vh] max-w-6xl flex flex-col" @close="tryClose">
    <template #header>
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="text-sm font-medium text-[var(--c-text-1)] truncate" :title="entry.name">{{ entry.name }}</span>
        <span v-if="ext" class="badge badge-muted shrink-0">{{ ext }}</span>
        <span v-if="dirty" class="status-text text-[var(--c-warning)] shrink-0">[UNSAVED]</span>
      </div>
      <a
        :href="downloadUrl(entry.path, token ?? '')"
        :download="entry.name"
        title="Download"
        class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors shrink-0"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
        </svg>
      </a>
    </template>

    <FilePreviewBody :entry="entry" ref="bodyRef" @dirty="dirty = $event" />

    <template v-if="kind === 'text'" #footer>
      <div class="flex-1" />
      <button class="btn btn-ghost btn-sm" @click="tryClose">Close</button>
      <button class="btn btn-primary btn-sm" :disabled="!dirty" @click="bodyRef?.save()">Save</button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 3: Typecheck and build**

Run from `apps/dashboard`:
```bash
pnpm exec vue-tsc -b
pnpm exec vite build
```
Expected: both succeed with zero errors.

- [ ] **Step 4: Manual no-regression check (when a browser is available)**

In fullscreen mode, open an image and a text file from Files; confirm both preview exactly as
before (image renders, text file edits/saves, Download link works, closing a dirty text file
prompts to discard). This step only confirms the refactor changed nothing observable — note
in your report if no browser was available to run it (the typecheck/build in Step 3 remain
the hard gate either way).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/file-browser/preview/FilePreviewBody.vue apps/dashboard/src/components/file-browser/preview/FilePreviewModal.vue
git commit -m "refactor(dashboard): extract FilePreviewBody from FilePreviewModal"
```

---

### Task 2: Extend `lib/desktop.ts` with a `file-preview` window kind

**Files:**
- Modify: `apps/dashboard/src/lib/desktop.ts`

**Interfaces:**
- Consumes: nothing new (extends the existing `useDesktop()` module).
- Produces: `AppId` includes `'file-preview'`; `export interface FilePreviewPayload { path: string; name: string; size: number | null }`; `DesktopWindow.filePreview?: FilePreviewPayload`; `useDesktop()` return object gains `openFilePreview(entry: FilePreviewPayload): void`.

- [ ] **Step 1: Add `'file-preview'` to `AppId` and define `FilePreviewPayload`**

In `apps/dashboard/src/lib/desktop.ts`, replace:

```ts
export type AppId = 'dashboard' | 'files' | 'apps' | 'settings'
export type SettingsSection = 'profile' | 'users' | 'places' | 'roles' | 'updates'
```

with:

```ts
export type AppId = 'dashboard' | 'files' | 'apps' | 'settings' | 'file-preview'
export type SettingsSection = 'profile' | 'users' | 'places' | 'roles' | 'updates'

export interface FilePreviewPayload {
  path: string
  name: string
  size: number | null
}
```

- [ ] **Step 2: Add the `filePreview` field to `DesktopWindow`**

Replace:

```ts
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
  focusNonce?: number
}
```

with:

```ts
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
  focusNonce?: number
  filePreview?: FilePreviewPayload
}
```

- [ ] **Step 3: Add `APP_LABEL`/`APP_ICON_PATH` entries and `DEFAULT_SIZE`/`MULTI_INSTANCE` for `'file-preview'`**

Replace:

```ts
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
```

with:

```ts
export const APP_LABEL: Record<AppId, string> = {
  dashboard: 'Overview',
  files: 'Files',
  apps: 'Apps',
  settings: 'Settings',
  'file-preview': 'Preview',
}

export const APP_ICON_PATH: Record<AppId, string> = {
  dashboard: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z',
  files: 'M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  apps: 'M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  'file-preview': 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
}
```

Replace:

```ts
const MULTI_INSTANCE = new Set<AppId>(['files'])
```

with:

```ts
const MULTI_INSTANCE = new Set<AppId>(['files', 'file-preview'])
```

Replace:

```ts
const DEFAULT_SIZE: Record<AppId, { w: number; h: number }> = {
  dashboard: { w: 720, h: 520 },
  files: { w: 860, h: 560 },
  apps: { w: 760, h: 540 },
  settings: { w: 860, h: 560 },
}
```

with:

```ts
const DEFAULT_SIZE: Record<AppId, { w: number; h: number }> = {
  dashboard: { w: 720, h: 520 },
  files: { w: 860, h: 560 },
  apps: { w: 760, h: 540 },
  settings: { w: 860, h: 560 },
  'file-preview': { w: 760, h: 560 },
}
```

- [ ] **Step 4: Add `openFilePreview()` inside `useDesktop()`**

In `apps/dashboard/src/lib/desktop.ts`, inside the `export function useDesktop() {` block, add this new
function right after the existing `closeWindow` function:

```ts
  function openFilePreview(entry: FilePreviewPayload) {
    const existing = windows.value.find(w => w.appId === 'file-preview' && w.filePreview?.path === entry.path)
    if (existing) {
      focusWindow(existing.id)
      return
    }
    const size = DEFAULT_SIZE['file-preview']
    const { x, y } = cascadeOffset()
    const win: DesktopWindow = {
      id: crypto.randomUUID(),
      appId: 'file-preview',
      x,
      y,
      w: size.w,
      h: size.h,
      minimized: false,
      maximized: false,
      zIndex: nextZIndex(),
      filePreview: entry,
    }
    windows.value.push(win)
    persist()
  }
```

Then add `openFilePreview` to the object returned by `useDesktop()`. Replace:

```ts
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

with:

```ts
  return {
    windows,
    desktopMode,
    setDesktopMode,
    openApp,
    openFilePreview,
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

- [ ] **Step 5: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors. (This will also catch any other file that switches on `AppId` exhaustively
without handling `'file-preview'` yet — at this point in the plan, no such file exists other
than `DesktopWindow.vue`'s body switch, which uses `v-else-if` chains, not an exhaustive
TypeScript `switch`, so no compile error is expected from Tasks 3-5 not having landed yet.)

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/desktop.ts
git commit -m "feat(dashboard): add file-preview window kind to useDesktop"
```

---

### Task 3: `DesktopWindow.vue` — render file-preview windows

**Files:**
- Modify: `apps/dashboard/src/components/desktop/DesktopWindow.vue`

**Interfaces:**
- Consumes: `FilePreviewBody.vue` (Task 1) — props `entry: { path, name, size }`, emits
  `dirty: [boolean]`, exposes `save(): void`. `FilePreviewPayload`, `openFilePreview` (Task 2,
  not directly called here, but `win.filePreview` is read). `downloadUrl` from
  `apps/dashboard/src/lib/file-url.ts` (already used by `FilePreviewModal.vue`, signature
  `downloadUrl(path: string, token: string): string`).
- Produces: nothing new for later tasks — this is purely a rendering change.

- [ ] **Step 1: Add new imports and `computed`**

Replace:

```ts
import { ref, onUnmounted, watch } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type DesktopWindow } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import DashboardPanel from '../dashboard/DashboardPanel.vue'
import FileBrowserPanel from '../file-browser/FileBrowserPanel.vue'
import AppsPanel from '../apps/AppsPanel.vue'
import SettingsPanel from '../SettingsPanel.vue'
```

with:

```ts
import { ref, computed, onUnmounted, watch } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type DesktopWindow } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import { downloadUrl } from '../../lib/file-url'
import DashboardPanel from '../dashboard/DashboardPanel.vue'
import FileBrowserPanel from '../file-browser/FileBrowserPanel.vue'
import AppsPanel from '../apps/AppsPanel.vue'
import SettingsPanel from '../SettingsPanel.vue'
import FilePreviewBody from '../file-browser/preview/FilePreviewBody.vue'
```

- [ ] **Step 2: Read `token` from `useAuth()` and add file-preview state + close guard**

Replace:

```ts
const { closeWindow, focusWindow, toggleMinimize, toggleMaximize, moveWindow, resizeWindow } = useDesktop()
const { isAdmin } = useAuth()

const appsPanelRef = ref<InstanceType<typeof AppsPanel> | null>(null)
const settingsPanelRef = ref<InstanceType<typeof SettingsPanel> | null>(null)

watch(() => props.win.focusNonce, () => {
  if (props.win.focusSection) settingsPanelRef.value?.focusOn(props.win.focusSection)
})
```

with:

```ts
const { closeWindow, focusWindow, toggleMinimize, toggleMaximize, moveWindow, resizeWindow } = useDesktop()
const { isAdmin, token } = useAuth()

const appsPanelRef = ref<InstanceType<typeof AppsPanel> | null>(null)
const settingsPanelRef = ref<InstanceType<typeof SettingsPanel> | null>(null)
const filePreviewRef = ref<{ save: () => void } | null>(null)
const filePreviewDirty = ref(false)

const filePreviewExt = computed(() => {
  const name = props.win.filePreview?.name ?? ''
  return name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
})

watch(() => props.win.focusNonce, () => {
  if (props.win.focusSection) settingsPanelRef.value?.focusOn(props.win.focusSection)
})

function onCloseClick() {
  if (props.win.appId === 'file-preview' && filePreviewDirty.value && !confirm('Discard unsaved changes?')) return
  closeWindow(props.win.id)
}
```

- [ ] **Step 3: Title bar — branch the left side on `win.appId === 'file-preview'`, add a Download button, and switch the close button to the new guarded handler**

Replace:

```html
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[win.appId]"/>
        </svg>
        <span class="eyebrow truncate">{{ APP_LABEL[win.appId] }}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0" @pointerdown.stop>
        <button
          v-if="win.appId === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          title="New App"
          class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
        </button>
        <button @click="toggleMinimize(win.id)" title="Minimize" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/>
          </svg>
        </button>
        <button @click="onMaximizeClick" :title="win.maximized ? 'Restore' : 'Maximize'" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg v-if="win.maximized" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 9V5a1 1 0 011-1h9a1 1 0 011 1v9a1 1 0 01-1 1h-4M5 9h9a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z"/>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 5h14v14H5z"/>
          </svg>
        </button>
        <button @click="closeWindow(win.id)" title="Close" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
```

with:

```html
      <div v-if="win.appId === 'file-preview'" class="flex items-center gap-2 min-w-0">
        <span class="text-xs text-[var(--c-text-1)] truncate" :title="win.filePreview?.name">{{ win.filePreview?.name }}</span>
        <span v-if="filePreviewExt" class="badge badge-muted shrink-0">{{ filePreviewExt }}</span>
        <span v-if="filePreviewDirty" class="status-text text-[var(--c-warning)] shrink-0 text-[10px]">[UNSAVED]</span>
      </div>
      <div v-else class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[win.appId]"/>
        </svg>
        <span class="eyebrow truncate">{{ APP_LABEL[win.appId] }}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0" @pointerdown.stop>
        <button
          v-if="win.appId === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          title="New App"
          class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
        </button>
        <a
          v-if="win.appId === 'file-preview'"
          :href="downloadUrl(win.filePreview!.path, token ?? '')"
          :download="win.filePreview!.name"
          title="Download"
          class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
        </a>
        <button @click="toggleMinimize(win.id)" title="Minimize" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/>
          </svg>
        </button>
        <button @click="onMaximizeClick" :title="win.maximized ? 'Restore' : 'Maximize'" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg v-if="win.maximized" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 9V5a1 1 0 011-1h9a1 1 0 011 1v9a1 1 0 01-1 1h-4M5 9h9a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z"/>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 5h14v14H5z"/>
          </svg>
        </button>
        <button @click="onCloseClick" title="Close" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
```

- [ ] **Step 4: Add the `file-preview` body case**

Replace:

```html
    <div class="flex-1 overflow-hidden">
      <DashboardPanel v-if="win.appId === 'dashboard'" class="h-full" />
      <FileBrowserPanel v-else-if="win.appId === 'files'" class="h-full" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" ref="settingsPanelRef" class="h-full" :focusSection="win.focusSection ?? null" />
    </div>
```

with:

```html
    <div class="flex-1 overflow-hidden">
      <DashboardPanel v-if="win.appId === 'dashboard'" class="h-full" />
      <FileBrowserPanel v-else-if="win.appId === 'files'" class="h-full" :desktopWindow="true" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" ref="settingsPanelRef" class="h-full" :focusSection="win.focusSection ?? null" />
      <FilePreviewBody v-else-if="win.appId === 'file-preview'" ref="filePreviewRef" :entry="win.filePreview!" class="h-full" @dirty="filePreviewDirty = $event" />
    </div>
```

(This step adds `:desktopWindow="true"` to the `FileBrowserPanel` line now — Task 5 defines
the prop on `FileBrowserPanel.vue` itself; passing it here first is harmless since Vue simply
ignores props a child hasn't declared yet, but both ends are needed for the feature to work,
and this is the only line in `DesktopWindow.vue` Task 5 needs to touch.)

- [ ] **Step 5: Typecheck and build**

Run from `apps/dashboard`:
```bash
pnpm exec vue-tsc -b
pnpm exec vite build
```
Expected: both succeed with zero errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/desktop/DesktopWindow.vue
git commit -m "feat(dashboard): render file-preview windows in DesktopWindow"
```

---

### Task 4: `Dock.vue` — show the file's name for file-preview windows

**Files:**
- Modify: `apps/dashboard/src/components/desktop/Dock.vue`

**Interfaces:**
- Consumes: `DesktopWindow.filePreview?: FilePreviewPayload` (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Change the dock icon's `title` binding**

Replace:

```html
        <button
          @click="onIconClick(w.id)"
          :title="APP_LABEL[w.appId]"
```

with:

```html
        <button
          @click="onIconClick(w.id)"
          :title="w.appId === 'file-preview' ? (w.filePreview?.name ?? APP_LABEL[w.appId]) : APP_LABEL[w.appId]"
```

- [ ] **Step 2: Typecheck**

Run from `apps/dashboard`: `pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/Dock.vue
git commit -m "feat(dashboard): show file name in Dock for file-preview windows"
```

---

### Task 5: `FileBrowserPanel.vue` — route `openFile` to a window in desktop mode

**Files:**
- Modify: `apps/dashboard/src/components/file-browser/FileBrowserPanel.vue`

**Interfaces:**
- Consumes: `openFilePreview(entry: FilePreviewPayload): void` from `useDesktop()` (Task 2).
- Produces: `<FileBrowserPanel :desktopWindow="boolean" />` prop, already wired from
  `DesktopWindow.vue` in Task 3 Step 4.

- [ ] **Step 1: Add the `desktopWindow` prop and import `useDesktop`**

In `apps/dashboard/src/components/file-browser/FileBrowserPanel.vue`, replace:

```ts
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useNotifications } from '../../lib/notifications'
import { useClipboard } from '../../lib/clipboard'
import { useUploads } from '../../lib/uploads'
import FilePermissionsDialog from '../FilePermissionsDialog.vue'
import PlacesSidebar from './PlacesSidebar.vue'
import FileToolbar from './FileToolbar.vue'
import FileListView from './FileListView.vue'
import FileGridView from './FileGridView.vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import FilePreviewModal from './preview/FilePreviewModal.vue'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type Place = { id: string; name: string; path: string }
interface Crumb { label: string; path: string; clickable: boolean }

const { isAdmin, token }    = useAuth()
const { track, trackBatch } = useNotifications()
const { clipboard, copy: clipCopy, cut: clipCut, clear: clipClear } = useClipboard()
const uploads = useUploads()
```

with:

```ts
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useNotifications } from '../../lib/notifications'
import { useClipboard } from '../../lib/clipboard'
import { useUploads } from '../../lib/uploads'
import { useDesktop } from '../../lib/desktop'
import FilePermissionsDialog from '../FilePermissionsDialog.vue'
import PlacesSidebar from './PlacesSidebar.vue'
import FileToolbar from './FileToolbar.vue'
import FileListView from './FileListView.vue'
import FileGridView from './FileGridView.vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import FilePreviewModal from './preview/FilePreviewModal.vue'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number | null; mtime: string }
type Place = { id: string; name: string; path: string }
interface Crumb { label: string; path: string; clickable: boolean }

const props = defineProps<{ desktopWindow?: boolean }>()

const { isAdmin, token }    = useAuth()
const { track, trackBatch } = useNotifications()
const { clipboard, copy: clipCopy, cut: clipCut, clear: clipClear } = useClipboard()
const uploads = useUploads()
const { openFilePreview } = useDesktop()
```

- [ ] **Step 2: Route `openFile` based on the new prop**

Replace:

```ts
function openFile(entry: Entry) {
  previewEntry.value = entry
}
```

with:

```ts
function openFile(entry: Entry) {
  if (props.desktopWindow) {
    openFilePreview({ path: entry.path, name: entry.name, size: entry.size })
  } else {
    previewEntry.value = entry
  }
}
```

- [ ] **Step 3: Typecheck and build**

Run from `apps/dashboard`:
```bash
pnpm exec vue-tsc -b
pnpm exec vite build
```
Expected: both succeed with zero errors.

- [ ] **Step 4: Manual end-to-end pass (when a browser is available)**

Enable desktop mode, open a Files window, open a text file and an image — confirm both
appear as independent windows with Dock icons named after the files, draggable/resizable/
minimizable/maximizable; edit the text file and confirm the unsaved dot appears in its title
bar and closing it prompts to discard; re-open the same text file from the same or a
different Files window and confirm it focuses the existing preview window instead of opening
a duplicate; reload the page and confirm the preview window reappears (without the unsaved
edit, consistent with this being disposable UI state like every other desktop-mode window).
Then switch to fullscreen mode and confirm opening files there still uses the unchanged Modal.
Note in your report if no browser was available to run this pass.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/file-browser/FileBrowserPanel.vue
git commit -m "feat(dashboard): open file previews as desktop windows in desktop mode"
```

---

## Self-Review

**Spec coverage:**
- `FilePreviewPayload`, `filePreview?` field, `openFilePreview()` with path-based dedup →
  Task 2. ✓
- `FilePreviewBody.vue` extraction, `FilePreviewModal.vue` unchanged-behavior wrapper →
  Task 1. ✓
- `DesktopWindow.vue` file-preview body case, custom title bar (filename/ext/download/unsaved),
  dirty-aware close → Task 3. ✓
- `Dock.vue` filename-as-title for file-preview windows; `Launchpad.vue` untouched (its
  `APP_IDS` is a literal 4-entry array, confirmed via the existing file, no task needed) →
  Task 4. ✓
- `FileBrowserPanel.vue` `desktopWindow` prop + `openFile()` routing → Task 5. ✓
- Edge cases (Files window closing independently of its preview windows, two Files windows
  deduping to one preview, reload tolerance, mobile unreachability) are all consequences of
  the data model in Task 2 and the prop-based routing in Task 5 — no separate task needed,
  confirmed by tracing: a `file-preview` `DesktopWindow` is a flat, independent entry in the
  same `windows` array as every other window, with no parent/child reference to the Files
  window that opened it.

**Placeholder scan:** no "TBD"/"TODO"/"similar to Task N" — every step has literal, complete
code or an exact shell command with expected output.

**Type consistency:** `FilePreviewPayload` defined once in Task 2, imported nowhere by name
in later tasks (Tasks 3 and 5 reference `win.filePreview`/the literal object shape directly,
which structurally matches since `DesktopWindow.filePreview` is typed `FilePreviewPayload |
undefined`). `openFilePreview(entry: FilePreviewPayload): void` signature in Task 2 matches
its call site in Task 5 (`openFilePreview({ path: entry.path, name: entry.name, size:
entry.size })`). `FilePreviewBody`'s props (`entry: { path, name, size }`) and exposed
`save()`/emitted `dirty` match both consumers: `FilePreviewModal.vue` (Task 1) and
`DesktopWindow.vue` (Task 3).
