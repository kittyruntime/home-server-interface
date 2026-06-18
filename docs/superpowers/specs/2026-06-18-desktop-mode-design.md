# Desktop mode: windowed shell, dock, and Launchpad

## Context

The dashboard currently shows exactly one of its four sections (Overview, Files, Apps,
Settings) fullscreen at a time, switched via fixed icons in a sidebar (`DashboardLayout.vue`).
The user wants a second, optional shell inspired by Synology DSM's desktop: each section opens
in its own draggable/resizable window, the existing sidebar becomes a dock of currently-open
windows, and a Launchpad overlay (macOS-style icon grid) is the entry point for launching apps.
The goal is a more "real desktop" feel for users who want multiple sections visible/arranged at
once, while keeping the current fullscreen behavior available and the existing Nothing-design
visual language (flat surfaces, border-separated elevation, no shadows, mono/uppercase labels)
unchanged.

This is additive: nothing about today's fullscreen mode, its components, or its data is
removed. Desktop mode is a new shell wrapping the same four existing panel components.

## Scope

- **In scope**: a `desktopMode` user preference (toggle + persistence), a window manager
  (`useDesktop()` composable) covering open/close/focus/minimize/maximize/move/resize/persist,
  a `DesktopShell.vue` + `DesktopWindow.vue` + `Dock.vue` + `Launchpad.vue` component set, and
  wiring the four existing panels (`DashboardPanel`, `FileBrowserPanel`, `AppsPanel`,
  `SettingsPanel`) into windows unchanged.
- **Out of scope**: embedding pinned external Docker apps as windows/iframes (explicitly
  decided against — most self-hosted apps block iframe embedding via X-Frame-Options/CSP, and
  the user confirmed the dock/Launchpad should only cover the four internal sections); a
  desktop wallpaper/background customization; windowed mode on mobile (falls back to today's
  fullscreen + bottom-nav, unconditionally, regardless of the preference).

## Architecture & state

A `desktopMode: boolean` preference lives in `localStorage` (key `desktopMode`), toggled from
the existing user dropdown menu in `DashboardLayout.vue` (next to "Profile"/"Sign out").
`DashboardLayout.vue` branches near the top of its template: if `desktopMode` is true **and**
the viewport is not mobile-width (reuse the existing `sm:` breakpoint already used for the
sidebar/bottom-nav split), render the new `DesktopShell.vue`; otherwise render exactly what
exists today. No existing markup/logic for the fullscreen mode is touched.

`apps/dashboard/src/lib/desktop.ts` exports `useDesktop()`, a module-level reactive singleton
following the exact pattern already used by `useAuth()` (`lib/auth.ts`) and `useUploads()` —
not Pinia/Vuex, this codebase doesn't use a state library.

```ts
type AppId = 'dashboard' | 'files' | 'apps' | 'settings'

interface DesktopWindow {
  id: string                                   // crypto.randomUUID()
  appId: AppId
  x: number; y: number; w: number; h: number
  minimized: boolean
  maximized: boolean
  prevRect?: { x: number; y: number; w: number; h: number }  // restore target after maximize
  zIndex: number
}
```

`MULTI_INSTANCE: Set<AppId> = new Set(['files'])` — every other app is single-instance.

State (`windows: Ref<DesktopWindow[]>`) is persisted to `localStorage` (key `desktop`) on every
mutation and restored on `useDesktop()`'s first call, mirroring the existing
`loadWidgets()`/`saveWidgets()` pattern in `DashboardPanel.vue` (`try/catch` around `JSON.parse`,
fall back to an empty desktop on any parse error or schema mismatch — no migration logic, this
is disposable UI state).

Exposed operations: `openApp(appId)`, `closeWindow(id)`, `focusWindow(id)`,
`toggleMinimize(id)`, `toggleMaximize(id)`, `moveWindow(id, x, y)`, `resizeWindow(id, w, h)`.

`openApp(appId)`:
- If `appId` is not in `MULTI_INSTANCE` and a window for it already exists → `focusWindow` it
  (restoring from minimized if needed) instead of creating a new one.
- Otherwise create a new `DesktopWindow` with a cascaded position offset from the
  most-recently-opened window (`+24px` x/y, wrapping back near the top-left once near the
  viewport edge), default size per app (e.g. Files/Settings start larger than Overview), and
  `zIndex` = current max + 1.

`focusWindow(id)` sets that window's `zIndex` to current max + 1 and clears `minimized`.

## Components

All new files under `apps/dashboard/src/components/desktop/`.

**`DesktopShell.vue`** — swaps in for today's `<main>` content area when active. Keeps the
existing `<aside>` sidebar slot (same 64px width/position) but its contents become `Dock.vue`
instead of the static nav icons. The desktop background is flat `bg-[var(--c-bg)]` — no
wallpaper, consistent with the established minimalism. Renders one `<DesktopWindow>` per
non-minimized entry in `windows`, in DOM order sorted by `zIndex` (later = on top, simplest way
to get correct paint/stacking order without manual `z-index` juggling beyond the data model).

**`DesktopWindow.vue`** — props: a `DesktopWindow` entry. Title bar: app icon (reuse the same
SVGs already used in today's sidebar/bottom-nav) + app label (`eyebrow` style: mono, uppercase,
tracking-wide) + three mono buttons on the right — minimize, maximize/restore, close — visually
matching the `[X]` already established as the standard close affordance in `Modal.vue` (e.g.
`[_]` `[□]` `[X]`). Body renders the matching existing panel component
(`DashboardPanel`/`FileBrowserPanel`/`AppsPanel`/`SettingsPanel`) based on `appId` — these
components are not modified, the window is purely a new container around them. Visual
elevation comes from border only: `border-[var(--c-border-strong)]` normally,
`border-[var(--c-accent)]` when focused (the topmost `zIndex`) — no `box-shadow`, no blur,
consistent with every other surface redesigned earlier in this project. `position: absolute`
within the desktop area, driven by the window's `x/y/w/h`.

**`Dock.vue`** — replaces the `<aside>`'s inner content in desktop mode. A Launchpad icon
(grid glyph) pinned at the top, in the same slot the brand mark occupies today, opens
`Launchpad.vue`. Below it: one icon per **currently open** window (not a fixed icon-per-app list
— if no Files window is open, no Files icon appears). Active indicator (the existing left-edge
accent bar pattern already used for nav state) when focused; dimmed/reduced-opacity icon when
minimized. Click: focus if visible, restore-and-focus if minimized. Multiple Files windows
render as multiple icons (or one icon with a small count badge — deferred to implementation,
not load-bearing for the design).

**`Launchpad.vue`** — fullscreen overlay (`Teleport to="body"`, near-opaque `bg-[var(--c-bg)]`),
a grid of exactly 4 large icons (always all four, regardless of what's already open — unlike the
dock). Click an icon → `openApp(appId)`, close the overlay. Escape key or click-on-backdrop also
closes without opening anything, matching the existing modal-dismissal convention in this app.

## Interactions

**Drag**: `pointerdown` on the title bar starts listening for `pointermove`/`pointerup` on
`window` (not the title bar element) so the drag isn't lost if the cursor leaves the element
during a fast move. Updates `x`/`y` live; clamped so the title bar can never be dragged fully
off-screen (at least N px of it must stay within the viewport on every edge). Persists on
`pointerup`.

**Resize**: small invisible hit-zones on the 4 edges + 4 corners (absolute-positioned strips a
few px wide/tall, with the matching `ns-resize`/`ew-resize`/`nwse-resize`/etc. cursor), same
pointer-event approach as drag. Minimum size ~320×240 to keep panel content usable.

**Minimize**: sets `minimized = true`; window disappears from the desktop, its dock icon dims.

**Maximize**: saves current `x/y/w/h` into `prevRect`, then sizes to fill the desktop area
(viewport minus the dock's width). Clicking again (now showing as "restore") reads back
`prevRect`.

**Close**: removes the entry from `windows`. No "unsaved changes" concern here — these are the
same four panels as today, which already manage their own internal save flows independently of
being shown in a window.

**Focus**: any pointerdown on a window (titlebar or body) or its dock icon brings it to the
front (`focusWindow`).

**Multi-instance (Files only)**: `openApp('files')` always creates a new cascaded window; for
every other app it focuses the existing one if present.

## Mode toggle & mobile

The toggle lives in the existing user dropdown menu, a simple labeled switch ("Desktop mode").
Flipping it just updates the `localStorage` preference and re-renders
`DashboardLayout.vue`'s branch — no data migration between modes; if you had `files` open as
the active fullscreen tab and switch to desktop mode, the desktop starts from its own persisted
window state (or empty, if none yet), not auto-carrying over the fullscreen tab's "active app".
On screens narrower than the existing `sm:` breakpoint, desktop mode is never rendered
regardless of the preference — same fullscreen + bottom-nav as today, unconditionally.

## Edge cases

- **Viewport shrinks below a persisted window's saved position/size**: on `DesktopShell.vue`
  mount, every restored window is re-clamped into the current viewport bounds (same clamp logic
  used during drag), so a window can never end up entirely or mostly off-screen after a browser
  resize.
- **Switching modes mid-session**: open desktop windows are untouched by switching to
  fullscreen and back; fullscreen's "active app" concept and desktop's window set are
  independent state that don't overwrite each other.
- **Corrupted/old-shape `localStorage` data**: `JSON.parse` wrapped in `try/catch`, any failure
  (or a future schema change) falls back to an empty desktop — same disposable-UI-state
  tolerance as the existing dashboard-widgets persistence.
- **Global overlays** (`NotificationsContainer`, `ConfirmDialog`, `NotificationMenu`) are
  unaffected — they're already `Teleport to="body"` and stay above everything, desktop windows
  included.

## Verification

- `pnpm exec vue-tsc -b` and `pnpm exec vite build` in `apps/dashboard` (the gate used
  throughout this project).
- Manual pass: enable desktop mode, open all 4 apps, drag/resize/minimize/maximize/close each,
  open 2+ Files windows simultaneously, reload the page (persistence round-trip), switch back to
  fullscreen and back to desktop (state preserved both ways), shrink the browser window with
  windows positioned near the edge (re-clamp check).
- The windowing mechanics themselves need no backend; the panels' actual content
  (Files/Apps/Settings) needs the backend exactly as much as it does today, unchanged.
