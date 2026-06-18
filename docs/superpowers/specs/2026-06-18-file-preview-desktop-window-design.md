# File preview as a real desktop window

## Context

Opening a file (image/video/audio preview, or the CodeMirror text/code editor) currently
always shows `FilePreviewModal.vue`: a `Teleport`-to-`body` `Modal.vue` overlay, identical in
both fullscreen mode and desktop mode (`docs/superpowers/specs/2026-06-18-desktop-mode-design.md`).
In desktop mode this feels wrong — it blocks the whole desktop instead of behaving like every
other window (draggable, resizable, minimizable, shows a Dock icon, persists across reload).
The user wants file previews to open as their own desktop window when desktop mode is active,
while leaving fullscreen mode's existing Modal-based behavior completely untouched.

## Scope

- **In scope**: a new `file-preview` window kind in the existing desktop window manager
  (`apps/dashboard/src/lib/desktop.ts`), a presentational extraction of the preview body so it
  can be hosted either by `Modal.vue` (fullscreen) or by `DesktopWindow.vue` (desktop mode),
  and the wiring needed so opening a file from a Files window inside desktop mode produces a
  real window instead of a Modal.
- **Out of scope**: any change to fullscreen mode's file-preview behavior (stays exactly as it
  is today — `FilePreviewModal.vue` wrapped in `Modal.vue`); any change to which file types are
  previewable or how binary detection/Range requests work server-side (untouched).

## Architecture & state

`apps/dashboard/src/lib/desktop.ts`:

```ts
export type AppId = 'dashboard' | 'files' | 'apps' | 'settings' | 'file-preview'

export interface FilePreviewPayload {
  path: string
  name: string
  size: number | null
}
```

`DesktopWindow` gains an optional field, parallel to the existing `focusSection?`:

```ts
filePreview?: FilePreviewPayload
```

`MULTI_INSTANCE` gains `'file-preview'` (multiple previews can be open at once, same as
`'files'`). A new exported function, alongside `openApp`:

```ts
function openFilePreview(entry: FilePreviewPayload): void
```

Dedup key is the file **path**, not the appId (unlike `openApp`'s single-instance apps):
if a `file-preview` window already has `filePreview.path === entry.path`, it is focused
(restoring from minimized if needed) instead of opening a second one — this was an explicit
decision to avoid two independent editors racing to save the same file. Otherwise a new
window is created: `appId: 'file-preview'`, `filePreview: entry`, default size `760×560`,
cascaded position and `zIndex` exactly like `openApp` does today.

`APP_LABEL`/`APP_ICON_PATH` (currently `Record<AppId, string>`) need an entry for
`'file-preview'` too, since the type now includes it — `APP_LABEL['file-preview']` is unused
in practice (see Dock below, which special-cases the title) but must exist to satisfy the
`Record<AppId, string>` type; `APP_ICON_PATH['file-preview']` is a generic file-document icon,
reused as the Dock fallback icon.

## Component refactor

`apps/dashboard/src/components/file-browser/preview/FilePreviewBody.vue` (new) — extracted
from today's `FilePreviewModal.vue`. Props: `entry: { path: string; name: string; size: number
| null }`. Emits: `dirty: [boolean]`. Exposes: `save(): void`. Contains exactly the kind-switch
and component logic `FilePreviewModal.vue` has today (`MediaPreview` for image/video/audio,
async-loaded `CodeEditor` for text), unchanged.

`FilePreviewModal.vue` becomes a thin wrapper, used only by fullscreen mode, behaviorally
identical to today: `<Modal>` with the existing header (filename, ext badge, download link,
`[UNSAVED]` badge), body = `<FilePreviewBody :entry="entry" @dirty="dirty = $event" ref=
"bodyRef">`, footer = existing Close/Save buttons calling `bodyRef.value?.save()`. The
discard-confirm `tryClose()` logic is unchanged.

## DesktopWindow.vue integration

A new body case, alongside the existing four:

```html
<FilePreviewBody v-else-if="win.appId === 'file-preview'" ref="filePreviewRef"
  :entry="win.filePreview!" class="h-full" @dirty="filePreviewDirty = $event" />
```

The title bar renders differently for this window kind: instead of the generic app icon +
`APP_LABEL`, it shows the filename (truncated, `eyebrow`-adjacent style matching
`FilePreviewModal.vue`'s header today) + an extension badge, plus a Download icon button
(same `downloadUrl()` helper, same icon already added to `FilePreviewModal.vue` in the earlier
icon cleanup) and a small unsaved-changes dot next to the filename when `filePreviewDirty` is
true. The standard minimize/maximize/close icon buttons stay in the same position. Closing a
`file-preview` window whose body reports `dirty` prompts the same native `confirm('Discard
unsaved changes?')` used by `FilePreviewModal.vue`'s `tryClose()` today, before calling
`closeWindow(win.id)`.

## Dock.vue / Launchpad.vue

`Launchpad.vue` is untouched — its `APP_IDS` list is a hardcoded 4-entry array
(`['dashboard','files','apps','settings']`), not derived from the `AppId` type, so adding
`'file-preview'` to the type doesn't add it to the Launchpad grid. File previews are never
"launched," only opened from within a Files window.

`Dock.vue` already renders one icon per open window regardless of `appId` (needed for `files`
multi-instance today). For a `file-preview` window, its icon uses `APP_ICON_PATH['file-preview']`
(the generic file icon) and its `title` attribute is the file's name (`win.filePreview?.name`)
instead of `APP_LABEL[w.appId]` — so hovering distinguishes which file each dock icon
represents when multiple previews are open.

## Wiring: FileBrowserPanel.vue

`FileBrowserPanel.vue` gains a new optional prop:

```ts
defineProps<{ desktopWindow?: boolean }>()
```

`openFile(entry)` becomes:

```ts
function openFile(entry: Entry) {
  if (props.desktopWindow) {
    openFilePreview({ path: entry.path, name: entry.name, size: entry.size })
  } else {
    previewEntry.value = entry
  }
}
```

`DesktopWindow.vue` passes `:desktopWindow="true"` on its `<FileBrowserPanel>` instance.
Fullscreen mode's `<FileBrowserPanel>` (in `DashboardLayout.vue`) passes nothing, so the prop
defaults to falsy and behavior is exactly as it is today — this is why the prop is the chosen
mechanism over re-deriving "am I in desktop mode" from `desktopMode`/`isMobile` globally: a
`FileBrowserPanel` instance is *always* either inside a `DesktopWindow` or inside the
fullscreen view, and the parent that mounts it already knows unambiguously which one, so it's
a single explicit boolean rather than two pieces of global state recombined inside the panel
(avoiding the edge case where `desktopMode` is true but the viewport is mobile-width, in which
case `FileBrowserPanel` is mounted by the fullscreen branch, not by a `DesktopWindow`).

## Edge cases

- **Files window closes while a preview opened from it is still open**: the preview window is
  completely independent state (its own `DesktopWindow` entry in the same flat `windows`
  array) — closing the Files window that originally triggered the preview has no effect on
  it. This is what makes the path-based dedup safe: a preview window's lifetime is its own.
- **Two different Files windows open the same file**: the second "open" dedupes to the first
  window's existing preview (focuses it) rather than creating a conflicting second editor.
- **Reload with an open, unsaved preview**: same disposable-UI-state tolerance as the rest of
  desktop mode — the window reappears on reload (its `filePreview` payload round-trips through
  `localStorage` like any other field), but in-memory editor edits that were never saved are
  lost, identical to today's Modal-based behavior on a reload (the Modal doesn't survive a
  reload either).
- **Mobile**: unreachable — `FileBrowserPanel` is never mounted with `desktopWindow="true"` on
  mobile, since `DesktopShell`/`DesktopWindow` never render below the `sm:` breakpoint.

## Verification

- `pnpm exec vue-tsc -b` and `pnpm exec vite build` in `apps/dashboard` (the established gate
  for this whole project — no test framework exists here).
- Manual pass (when a browser is available): open a text file and an image from a Files
  window in desktop mode, confirm both appear as independent, draggable/resizable/minimizable
  windows with Dock icons named after the files; edit the text file, confirm the unsaved dot
  appears and closing prompts to discard; open the same text file again from the same or a
  different Files window, confirm it focuses the existing preview window instead of opening a
  second one; reload, confirm the preview window (without the unsaved edit) reappears.
