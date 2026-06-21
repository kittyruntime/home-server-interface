# Desktop mode: widgets-as-wallpaper + background customization

## Context

`docs/superpowers/specs/2026-06-18-desktop-mode-design.md` introduced desktop mode (windows,
Dock, Launchpad) and explicitly scoped out wallpaper/background customization, keeping
`DesktopShell.vue`'s background flat (`bg-[var(--c-bg)]`). This spec reverses that one decision:
in desktop mode, the Overview dashboard's metrics widgets (CPU, memory, network, containers)
move from being a window-able app to living directly on the desktop background, and the
background itself becomes customizable (solid color or uploaded image).

Fullscreen mode (the existing sidebar-tab UI in `DashboardLayout.vue`) is untouched — its
Overview tab keeps `DashboardPanel.vue` exactly as it is today. This change is scoped to
desktop mode only.

## Scope

- **In scope**: removing `dashboard` as a window-able `AppId` in desktop mode; rendering the
  widget grid as a background layer in `DesktopShell.vue`; a right-click context menu on the
  desktop background for wallpaper changes and widget management; solid-color and
  image-upload wallpaper backed by a new per-user backend setting; a short-lived scoped token
  for serving the wallpaper image to an `<img>` tag (same pattern as the recent file-preview
  token fix).
- **Out of scope**: any change to fullscreen mode's Overview tab or `DashboardPanel.vue`'s
  existing behavior; free-form (drag-to-position) widget placement — the grid layout is
  unchanged, just relocated; multiple wallpapers/themes per user; animated/video wallpapers.

## Data model & storage

`packages/database/prisma/schema/user.prisma`: add one nullable JSON column:

```prisma
wallpaper Json? // { kind: 'color', value: string } | { kind: 'image', ext: string } | null
```

`null` = default flat background (today's behavior, fully backward compatible).

Uploaded wallpaper images are **not** routed through the Go root-worker/NATS filesystem
abstraction — they're an internal UI setting, not a NAS-browsable user file. They're written
directly by the Node backend process to a new app-data directory, sibling to the SQLite DB:

```
apps/backend/data/wallpapers/<userId>.<ext>
```

One file per user; uploading a new image deletes the previous one first (`fs.unlink`, ignore
`ENOENT`). Max 8 MB, allowed types `image/png`, `image/jpeg`, `image/webp` — validated by
magic-byte sniff on the first few bytes server-side, not just trusting the `Content-Type`
header.

## Backend

**New router** `apps/backend/src/trpc/routers/wallpaper.ts`:

- `get` (query) → returns `{ kind: 'none' | 'color' | 'image', value?: string }` (the JSON
  column verbatim, `'none'` when null).
- `setColor` (mutation, `z.object({ value: z.string() })`) → validates `value` is a `#rrggbb`
  hex string, deletes any existing wallpaper image file for this user (switching from image to
  color shouldn't leave an orphaned file), writes `{ kind: 'color', value }` to `User.wallpaper`.
- `clear` (mutation) → deletes any wallpaper image file, sets `User.wallpaper` to `null`.
- `createImageToken` (query) → only valid when the user currently has `kind: 'image'`; mints a
  short-lived (15m) token scoped `{ userId, scope: 'wallpaper-read' }` via a new
  `signWallpaperToken` in `apps/backend/src/trpc/auth.ts` (sibling to the existing
  `signFileToken`/`verifyFileToken` pair added for the file-preview fix — same rationale:
  `<img src>` can't carry an `Authorization` header, so a long-lived session JWT must never
  end up in that URL).

**Image upload** — superseded during implementation: rather than a separate
`POST /files/wallpaper-upload` multipart route, the image is uploaded through the same
`wallpaper` tRPC router as a `setImage` mutation (`{ data: base64, mimeType }`), validated
server-side by magic-byte sniff (not the client-sent `mimeType`), capped at 8MB, and written to
`apps/backend/data/wallpapers/<userId>.<ext>` before updating `User.wallpaper` to
`{ kind: 'image', ext }`. This keeps upload validation co-located with the other wallpaper
procedures instead of introducing a second auth/validation path; the ~33% base64 overhead is
negligible at this size.

**New route** `GET /files/wallpaper-image?token=...` — verifies the token via a new
`verifyWallpaperToken`, looks up that user's `User.wallpaper` row to confirm it's still
`kind: 'image'` and resolve the extension, streams the file from
`apps/backend/data/wallpapers/<userId>.<ext>` with the matching `Content-Type`.

## Frontend — `AppId` / Dock / Launchpad

`apps/dashboard/src/lib/desktop.ts`:

- `AppId` becomes `'files' | 'apps' | 'settings' | 'file-preview'` (drop `'dashboard'`).
- Drop the `dashboard` entries from `APP_LABEL`, `APP_ICON_PATH`, `DEFAULT_SIZE`.
- `loadWindows()`: filter out any parsed entry with `appId === 'dashboard'` before returning —
  silently dropped, same disposable-state tolerance already used for corrupt/old-shape JSON.

`Launchpad.vue`: `APP_IDS` becomes `['files', 'apps', 'settings']` (grid goes 4→3 icons).

`Dock.vue`: no structural change — it already only ever renders icons for currently-open
windows, and a `dashboard` window can no longer exist.

## Frontend — widget extraction

Extract the widget-management logic currently inline in `DashboardPanel.vue` into a composable
`apps/dashboard/src/lib/dashboard-widgets.ts`: `useDashboardWidgets()` owns the `CATALOG`,
`Widget`/`WidgetType` types, `DEFAULT_WIDGETS`, `loadWidgets()`/`saveWidgets()`
(`localStorage['dashboard']`, unchanged key), the 3s metrics poll + container list fetch, the
`cpuHist`/`rxHist`/`txHist` sparkline arrays, and `addWidget`/`removeWidget`/`toggleCols`.

`DashboardPanel.vue` is refactored to consume this composable instead of owning the logic
inline — its template, hover-revealed per-card controls, and the "Add" dropdown are otherwise
unchanged, and so is its behavior in fullscreen mode.

**New** `apps/dashboard/src/components/desktop/DesktopWidgets.vue` — consumes the same
composable, renders the same grid/card markup, but with **no hover-revealed controls**.
Widget management here happens entirely through the right-click context menu below.

## Frontend — wallpaper layer & context menu

**New** `apps/dashboard/src/lib/wallpaper.ts`: `useWallpaper()` (module-singleton composable,
same pattern as `useDesktop()`/`useAuth()`) — loads `trpc.wallpaper.get` once, exposes
`backgroundStyle` (a computed `{ backgroundColor }` or `{ backgroundImage: url(...) }` for
`kind: 'color'`/`'image'` respectively, `{}` for `'none'`), and `setColor()`, `setImage(file)`,
`clear()` wrapping the corresponding tRPC calls. For `kind: 'image'`, it mints an image token
via `wallpaper.createImageToken` and builds the `/files/wallpaper-image?token=...` URL the same
way `lib/file-url.ts` does for file previews.

`DesktopShell.vue` changes:
- Root div's background switches from the hardcoded `bg-[var(--c-bg)]` class to
  `:style="backgroundStyle"` (falling back to the same flat `var(--c-bg)` via CSS when
  `backgroundStyle` is empty — set as the div's default background via a CSS class that stays
  applied underneath the inline style).
- Renders `<DesktopWidgets />` as a layer between the background and the
  `<DesktopWindow v-for...>` loop (i.e., behind every window, but above the flat/color/image
  background).
- A `contextmenu` handler on the root div (ignored if the event target is inside a window or a
  widget card — checked via `closest()`) opens a new context-menu element, positioned at the
  click coordinates, with two items: "Change wallpaper..." and "Add widget ▸" (submenu listing
  any `CATALOG` entries not currently present in the widget list — hidden entirely if none are
  available to add). Built inline following the exact same `Teleport to="body"` +
  position-by-click-coordinates + backdrop-click-to-close pattern already used for the file
  browser's context menu (`FileBrowserPanel.vue`), not a new reusable component — this is the
  second use of that pattern, not yet worth abstracting.
- A `contextmenu` handler on each widget card in `DesktopWidgets.vue` opens the same kind of
  menu with "Toggle size" and "Remove widget" items instead.
- "Change wallpaper..." opens a new `WallpaperPicker.vue` (`Modal.vue`-based): a row of solid
  color swatches sourced from the existing `--c-accent`/gray design tokens plus a free hex
  `<input type="color">`, an "Upload image..." file input, and a "Reset to default" button.

## Edge cases

- **Switching desktop mode off and back on**: widget/wallpaper state is unaffected — it's keyed
  off `localStorage['dashboard']` and the backend `User.wallpaper` column, neither of which the
  mode toggle touches.
- **Wallpaper image upload fails validation (too large/wrong type)**: `wallpaper-upload` returns
  4xx with a reason; `WallpaperPicker.vue` shows the existing inline-status-text pattern used
  elsewhere in the app, not a toast.
- **User deletes their account / wallpaper file goes missing**: `GET /files/wallpaper-image`
  404s if the file isn't found for a token that otherwise verifies; `DesktopShell.vue` falls
  back to the flat default background on image load error (`@error` on the underlying `<img>`-
  equivalent — implemented as a CSS `background-image`, so this is handled by checking the
  wallpaper-token mint/fetch result before setting `backgroundStyle`, not a DOM `<img>` tag).
- **Old persisted desktop window state referencing `appId: 'dashboard'`**: silently dropped on
  load (see above) — no migration, consistent with this state already being treated as
  disposable UI state throughout `desktop.ts`.

## Verification

- `pnpm exec vue-tsc -b` and `pnpm exec vite build` in `apps/dashboard`.
- `pnpm exec tsc --noEmit` in `apps/backend`.
- `pnpm prisma migrate dev` (or the project's equivalent) for the new `wallpaper` column.
- Manual pass: desktop mode shows widgets on the background with no Overview window available
  in Launchpad/Dock; right-click empty desktop → change wallpaper to a color, then to an
  uploaded image, then reset to default; right-click a widget → toggle size and remove; add a
  removed widget back via the submenu; reload the page (wallpaper and widget state both persist
  — one from the backend, one from `localStorage`); confirm fullscreen mode's Overview tab is
  pixel-for-pixel unchanged.
