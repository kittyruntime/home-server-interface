# Desktop wallpaper + widgets-as-background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In desktop mode, move the Overview metrics widgets from a window-able app onto the desktop background, and make that background customizable (solid color or uploaded image), per the spec at `docs/superpowers/specs/2026-06-19-desktop-wallpaper-widgets-design.md`.

**Architecture:** Extract the existing widget logic out of `DashboardPanel.vue` into a shared composable so a new `DesktopWidgets.vue` can render it directly on `DesktopShell.vue`'s background layer, behind all windows. A new backend `wallpaper` tRPC router stores a per-user color/image choice (`User.wallpaper` JSON column); uploaded images are written straight to a local app-data directory by the Node process (no NATS/root-worker — these aren't NAS files), and served back to `<img>`-equivalent CSS backgrounds via a short-lived scoped token, mirroring the file-preview token fix already in this codebase.

**Tech Stack:** Vue 3 + TS (Composition API, module-singleton composables, Tailwind, no state library), Fastify + tRPC + Prisma/SQLite backend, no test framework in this repo (verification is `vue-tsc`/`vite build`/`tsc --noEmit` + manual pass).

## Global Constraints

- No NATS/root-worker involvement for wallpaper images — plain `node:fs` against a local app-data directory, since this is a UI setting, not a NAS-browsable file.
- Wallpaper image upload: max 8 MB, only `image/png`, `image/jpeg`, `image/webp`, validated by magic-byte sniff server-side (not just trusting any client-sent MIME string).
- The wallpaper image token is short-lived (15m) and scoped (`scope: "wallpaper-read"`), mirroring the existing `signFileToken`/`verifyFileToken` pair in `apps/backend/src/trpc/auth.ts` — never reuse the long-lived session JWT in a URL.
- Fullscreen mode's Overview tab (`DashboardLayout.vue`, `DashboardPanel.vue`) must remain byte-for-byte behaviorally unchanged. This plan only touches desktop mode.
- `dashboard` is removed from the desktop-mode `AppId` union entirely — it can never again be a window.
- Verification gates: `pnpm exec vue-tsc -b && pnpm exec vite build` in `apps/dashboard`; `pnpm exec tsc --noEmit` in `apps/backend`.

---

## Task 1: `User.wallpaper` column + migration

**Files:**
- Modify: `packages/database/prisma/schema/user.prisma`

**Interfaces:**
- Produces: `User.wallpaper: Json | null` — shape (enforced at the application layer, not by Prisma): `{ kind: 'color', value: string }` or `{ kind: 'image', ext: string }`. `null` means "no custom wallpaper, use the default flat background."

- [ ] **Step 1: Add the column**

Edit `packages/database/prisma/schema/user.prisma`:

```prisma
model User {
  id               String                @id @default(uuid())
  username         String                @unique
  password         String
  displayName      String?
  linuxUsername    String?
  wallpaper        Json?
  createdAt        DateTime              @default(now())
  updatedAt        DateTime              @updatedAt
  userRoles        UserRole[]
  placePermissions UserPlacePermission[]
}
```

- [ ] **Step 2: Generate and apply the migration**

Run:
```bash
cd packages/database && npx prisma migrate dev --name add_user_wallpaper
```
Expected: prisma creates `packages/database/prisma/migrations/<timestamp>_add_user_wallpaper/migration.sql` containing `ALTER TABLE "User" ADD COLUMN "wallpaper" JSONB;` (SQLite stores this as TEXT), applies it to the dev DB, and regenerates the Prisma client.

- [ ] **Step 3: Verify the client picked up the new field**

Run: `cd packages/database && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (the generated `@prisma/client` types now include `wallpaper` on `User`).

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema/user.prisma packages/database/prisma/migrations
git commit -m "feat(database): add User.wallpaper column for desktop background customization"
```

---

## Task 2: Backend wallpaper token pair (`auth.ts`)

**Files:**
- Modify: `apps/backend/src/trpc/auth.ts`

**Interfaces:**
- Consumes: nothing new (sibling to the existing `signFileToken`/`verifyFileToken`, same `JWT_SECRET`).
- Produces: `signWallpaperToken(userId: string): string`, `verifyWallpaperToken(token: string): WallpaperTokenPayload`, `interface WallpaperTokenPayload { userId: string; scope: "wallpaper-read" }`.

- [ ] **Step 1: Add the token pair**

Append to `apps/backend/src/trpc/auth.ts`, directly after the existing `verifyFileToken` function (after line 50):

```ts
// ── Wallpaper image tokens ───────────────────────────────────────────────────
// Same rationale as the file-read tokens above: the desktop background's
// CSS background-image URL can't carry an Authorization header, so a
// short-lived token scoped to "this user's wallpaper, nothing else" is
// minted on demand instead of putting the session JWT in that URL.
export interface WallpaperTokenPayload {
  userId: string
  scope: "wallpaper-read"
}

export function signWallpaperToken(userId: string): string {
  return jwt.sign({ userId, scope: "wallpaper-read" }, JWT_SECRET, { expiresIn: "15m" })
}

export function verifyWallpaperToken(token: string): WallpaperTokenPayload {
  const payload = jwt.verify(token, JWT_SECRET) as WallpaperTokenPayload
  if (payload.scope !== "wallpaper-read") throw new Error("Invalid token scope")
  return payload
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/trpc/auth.ts
git commit -m "feat(backend): add scoped wallpaper-read token pair"
```

---

## Task 3: Image magic-byte sniff util

**Files:**
- Create: `apps/backend/src/utils/image-sniff.ts`

**Interfaces:**
- Produces: `detectImageType(buf: Buffer): 'png' | 'jpeg' | 'webp' | null`

- [ ] **Step 1: Write the util**

Create `apps/backend/src/utils/image-sniff.ts`:

```ts
// Cheap magic-byte sniff for the three image types the wallpaper upload
// accepts — mirrors utils/text-sniff.ts's "don't trust the client's
// Content-Type, look at the actual bytes" approach.
export function detectImageType(buf: Buffer): "png" | "jpeg" | "webp" | null {
  if (buf.length < 12) return null

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp"

  return null
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/utils/image-sniff.ts
git commit -m "feat(backend): add image magic-byte sniff for wallpaper uploads"
```

---

## Task 4: Wallpaper storage helper

**Files:**
- Create: `apps/backend/src/services/wallpaper-storage.ts`

**Interfaces:**
- Produces: `wallpaperPath(userId: string, ext: string): string`, `async function deleteWallpaperFile(userId: string, ext: string): Promise<void>`, `async function writeWallpaperFile(userId: string, ext: string, data: Buffer): Promise<void>`.
- Consumes: nothing new.

- [ ] **Step 1: Write the helper**

Create `apps/backend/src/services/wallpaper-storage.ts`:

```ts
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile, unlink } from "node:fs/promises"

// Plain local app-data storage — these are small UI-setting images, not
// NAS-browsable user files, so they deliberately skip the
// NATS/root-worker pipeline used for everything under fs.ts. Same
// resolution pattern as DASHBOARD_DIR in app.ts: env override for
// production layouts, otherwise relative to this module's own directory.
const WALLPAPER_DIR = process.env.WALLPAPER_DIR
  ? path.resolve(process.env.WALLPAPER_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/wallpapers")

export function wallpaperPath(userId: string, ext: string): string {
  return path.join(WALLPAPER_DIR, `${userId}.${ext}`)
}

export async function writeWallpaperFile(userId: string, ext: string, data: Buffer): Promise<void> {
  await mkdir(WALLPAPER_DIR, { recursive: true })
  await writeFile(wallpaperPath(userId, ext), data)
}

export async function deleteWallpaperFile(userId: string, ext: string): Promise<void> {
  try {
    await unlink(wallpaperPath(userId, ext))
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/services/wallpaper-storage.ts
git commit -m "feat(backend): add local app-data storage helper for wallpaper images"
```

---

## Task 5: `wallpaper` tRPC router

**Files:**
- Create: `apps/backend/src/trpc/routers/wallpaper.ts`
- Modify: `apps/backend/src/trpc/routers/index.ts`

**Interfaces:**
- Consumes: `signWallpaperToken` (Task 2), `detectImageType` (Task 3), `writeWallpaperFile`/`deleteWallpaperFile`/`wallpaperPath` (Task 4), `protectedProcedure`/`router` (`../index`), `ctx.prisma`, `ctx.user.userId`.
- Produces (tRPC procedures other tasks will call from the frontend):
  - `wallpaper.get` (query, no input) → `{ kind: 'none' } | { kind: 'color'; value: string } | { kind: 'image' }`
  - `wallpaper.setColor` (mutation, `{ value: string }`) → `{ ok: true }`
  - `wallpaper.setImage` (mutation, `{ data: string; mimeType: string }` where `data` is base64) → `{ ok: true }`
  - `wallpaper.clear` (mutation, no input) → `{ ok: true }`
  - `wallpaper.createImageToken` (query, no input) → `{ token: string }`

- [ ] **Step 1: Write the router**

Create `apps/backend/src/trpc/routers/wallpaper.ts`:

```ts
import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, protectedProcedure } from "../index"
import { signWallpaperToken } from "../auth"
import { detectImageType } from "../../utils/image-sniff"
import { writeWallpaperFile, deleteWallpaperFile } from "../../services/wallpaper-storage"

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

type WallpaperValue =
  | { kind: "color"; value: string }
  | { kind: "image"; ext: string }

export const wallpaperRouter = router({

  // ── get (sync) ────────────────────────────────────────────────────────────
  get: protectedProcedure.query(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { wallpaper: true },
    })
    const w = u?.wallpaper as WallpaperValue | null
    if (!w) return { kind: "none" as const }
    if (w.kind === "color") return { kind: "color" as const, value: w.value }
    return { kind: "image" as const }
  }),

  // ── setColor (sync) ───────────────────────────────────────────────────────
  setColor: protectedProcedure
    .input(z.object({ value: z.string().regex(HEX_COLOR) }))
    .mutation(async ({ ctx, input }) => {
      const u = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.userId },
        select: { wallpaper: true },
      })
      const prev = u?.wallpaper as WallpaperValue | null
      if (prev?.kind === "image") await deleteWallpaperFile(ctx.user.userId, prev.ext)

      await ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data: { wallpaper: { kind: "color", value: input.value } },
      })
      return { ok: true }
    }),

  // ── setImage (sync) ───────────────────────────────────────────────────────
  setImage: protectedProcedure
    .input(z.object({ data: z.string(), mimeType: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const buf = Buffer.from(input.data, "base64")
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image must be 1 byte to 8 MB" })
      }
      const detected = detectImageType(buf)
      if (!detected) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Unrecognized image format (PNG/JPEG/WEBP only)" })
      }

      const u = await ctx.prisma.user.findUnique({
        where: { id: ctx.user.userId },
        select: { wallpaper: true },
      })
      const prev = u?.wallpaper as WallpaperValue | null
      if (prev?.kind === "image" && prev.ext !== detected) {
        await deleteWallpaperFile(ctx.user.userId, prev.ext)
      }

      const ext = detected === "jpeg" ? "jpg" : detected
      await writeWallpaperFile(ctx.user.userId, ext, buf)
      await ctx.prisma.user.update({
        where: { id: ctx.user.userId },
        data: { wallpaper: { kind: "image", ext } },
      })
      return { ok: true }
    }),

  // ── clear (sync) ──────────────────────────────────────────────────────────
  clear: protectedProcedure.mutation(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { wallpaper: true },
    })
    const prev = u?.wallpaper as WallpaperValue | null
    if (prev?.kind === "image") await deleteWallpaperFile(ctx.user.userId, prev.ext)

    await ctx.prisma.user.update({
      where: { id: ctx.user.userId },
      data: { wallpaper: null },
    })
    return { ok: true }
  }),

  // ── createImageToken (sync) ───────────────────────────────────────────────
  createImageToken: protectedProcedure.query(async ({ ctx }) => {
    const u = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.userId },
      select: { wallpaper: true },
    })
    const w = u?.wallpaper as WallpaperValue | null
    if (w?.kind !== "image") throw new TRPCError({ code: "NOT_FOUND", message: "No wallpaper image set" })
    return { token: signWallpaperToken(ctx.user.userId) }
  }),
})
```

- [ ] **Step 2: Register the router**

In `apps/backend/src/trpc/routers/index.ts`, add the import and entry:

```ts
import { router } from "../index"
import { authRouter } from "./auth"
import { userRouter } from "./user"
import { placeRouter } from "./place"
import { fsRouter } from "./fs"
import { roleRouter } from "./role"
import { permissionRouter } from "./permission"
import { tasksRouter } from "./tasks"
import { containerRouter } from "./container"
import { systemRouter } from "./system"
import { updateRouter } from "./update"
import { wallpaperRouter } from "./wallpaper"

export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  place: placeRouter,
  fs: fsRouter,
  role: roleRouter,
  permission: permissionRouter,
  tasks: tasksRouter,
  container: containerRouter,
  system: systemRouter,
  update: updateRouter,
  wallpaper: wallpaperRouter,
})

export type AppRouter = typeof appRouter
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: no errors. (If `ctx.prisma.user.update` complains about the `wallpaper` field type, confirm Task 1's `npx prisma generate` actually ran — rerun `cd packages/database && npx prisma generate` if needed.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/trpc/routers/wallpaper.ts apps/backend/src/trpc/routers/index.ts
git commit -m "feat(backend): add wallpaper tRPC router (get/setColor/setImage/clear/createImageToken)"
```

---

## Task 6: `GET /files/wallpaper-image` route

**Files:**
- Modify: `apps/backend/src/routes/files.ts`

**Interfaces:**
- Consumes: `verifyWallpaperToken` (Task 2), `wallpaperPath` (Task 4), `prisma` (already imported in this file).
- Produces: route `GET /files/wallpaper-image?token=...` serving the binary image.

- [ ] **Step 1: Add the route**

In `apps/backend/src/routes/files.ts`:
1. Add `import { createReadStream } from "node:fs"` is already present (line 2) — reuse it.
2. Add `import { stat } from "node:fs/promises"` is already present (line 3) — reuse it.
3. Change the auth import on line 5 to also pull in the new verifier:

```ts
import { verifyToken, verifyFileToken, verifyWallpaperToken, isTokenBlacklisted } from "../trpc/auth"
```

4. Add a new import for the storage helper, near the other local imports (after line 13):

```ts
import { wallpaperPath } from "../services/wallpaper-storage"
```

5. Add the route inside `export async function fileRoutes(app: FastifyInstance) { ... }`, directly after the closing `})` of the existing `/files/download` route (after line 209):

```ts
  // ── GET /files/wallpaper-image?token=<wallpaper-token> ───────────────────
  //
  // Same rationale as /files/download's token: a CSS background-image URL
  // can't carry an Authorization header, so this is gated by a short-lived
  // (15m) token scoped to exactly "this user's wallpaper", minted via
  // wallpaper.createImageToken — never the long-lived session JWT.
  app.get("/files/wallpaper-image", async (req, reply) => {
    const { token } = req.query as Record<string, string>
    if (!token) return reply.status(400).send("Missing token")

    let userId: string
    try {
      userId = verifyWallpaperToken(token).userId
    } catch {
      return reply.status(401).send("Unauthorized")
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { wallpaper: true } })
    const w = user?.wallpaper as { kind: string; ext?: string } | null
    if (w?.kind !== "image" || !w.ext) return reply.status(404).send("Not found")

    const filePath = wallpaperPath(userId, w.ext)
    let fileSize: number
    try {
      const s = await stat(filePath)
      fileSize = s.size
    } catch {
      return reply.status(404).send("Not found")
    }

    const mime = w.ext === "jpg" ? "image/jpeg" : `image/${w.ext}`
    reply.header("Content-Type", mime)
    reply.header("Cache-Control", "private, max-age=300")
    reply.header("Content-Length", String(fileSize))
    return reply.send(createReadStream(filePath))
  })
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/routes/files.ts
git commit -m "feat(backend): serve wallpaper images via scoped token"
```

---

## Task 7: Frontend `useWallpaper()` composable

**Files:**
- Create: `apps/dashboard/src/lib/wallpaper.ts`

**Interfaces:**
- Consumes: `trpc` (`./trpc`).
- Produces: `useWallpaper()` returning `{ backgroundStyle: ComputedRef<Record<string, string>>, setColor(value: string): Promise<void>, setImage(file: File): Promise<void>, clear(): Promise<void> }`.

- [ ] **Step 1: Write the composable**

Create `apps/dashboard/src/lib/wallpaper.ts`:

```ts
import { ref, computed } from 'vue'
import { trpc } from './trpc'

const BASE_URL = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''

type WallpaperState =
  | { kind: 'none' }
  | { kind: 'color'; value: string }
  | { kind: 'image'; url: string }

const state = ref<WallpaperState>({ kind: 'none' })
let loaded = false

async function loadImageUrl(): Promise<string> {
  const { token } = await trpc.wallpaper.createImageToken.query()
  return `${BASE_URL}/files/wallpaper-image?token=${encodeURIComponent(token)}`
}

async function refresh() {
  const w = await trpc.wallpaper.get.query()
  if (w.kind === 'color') {
    state.value = { kind: 'color', value: w.value }
  } else if (w.kind === 'image') {
    state.value = { kind: 'image', url: await loadImageUrl() }
  } else {
    state.value = { kind: 'none' }
  }
}

export function useWallpaper() {
  if (!loaded) {
    loaded = true
    refresh().catch(() => { state.value = { kind: 'none' } })
  }

  const backgroundStyle = computed<Record<string, string>>(() => {
    if (state.value.kind === 'color') return { backgroundColor: state.value.value }
    if (state.value.kind === 'image') {
      return {
        backgroundImage: `url(${JSON.stringify(state.value.url)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    }
    return {}
  })

  async function setColor(value: string) {
    await trpc.wallpaper.setColor.mutate({ value })
    state.value = { kind: 'color', value }
  }

  async function setImage(file: File) {
    const buf = await file.arrayBuffer()
    const data = btoa(String.fromCharCode(...new Uint8Array(buf)))
    await trpc.wallpaper.setImage.mutate({ data, mimeType: file.type })
    state.value = { kind: 'image', url: await loadImageUrl() }
  }

  async function clear() {
    await trpc.wallpaper.clear.mutate()
    state.value = { kind: 'none' }
  }

  return { backgroundStyle, setColor, setImage, clear }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/wallpaper.ts
git commit -m "feat(dashboard): add useWallpaper composable"
```

---

## Task 8: Extract `useDashboardWidgets()` composable

**Files:**
- Create: `apps/dashboard/src/lib/dashboard-widgets.ts`
- Modify: `apps/dashboard/src/components/dashboard/DashboardPanel.vue`

**Interfaces:**
- Produces: `useDashboardWidgets()` returning `{ widgets: Ref<Widget[]>, metrics: Ref<Metrics | null>, containers: Ref<ContainerStatus[]>, cpuHist: Ref<number[]>, rxHist: Ref<number[]>, txHist: Ref<number[]>, CATALOG, uptimeStr: ComputedRef<string>, ctrRunning/ctrStopped/ctrError: ComputedRef<number>, spark, fmtBytes, fmtMem, memColor, toggleCols(w: Widget), removeWidget(id: string), addWidget(type: WidgetType) }` plus the exported types `WidgetType`, `Widget`.
- Consumes: `trpc` (`./trpc`).

This is a pure extraction — no behavior change. `DashboardPanel.vue`'s template/markup stays exactly as-is; only its `<script setup>` changes to pull from the composable instead of declaring the logic inline.

- [ ] **Step 1: Create the composable with the extracted logic**

Create `apps/dashboard/src/lib/dashboard-widgets.ts`:

```ts
import { ref, computed, onMounted, onUnmounted, type Ref } from 'vue'
import { trpc } from './trpc'

export type WidgetType = 'cpu' | 'memory' | 'network' | 'containers'
export interface Widget { id: string; type: WidgetType; cols: 1 | 2 }

interface Metrics {
  cpu:     number
  memory:  { total: number; used: number; percent: number }
  network: { rx: number; tx: number }
  uptime:  number
}

type ContainerStatus = { status: string }

export const CATALOG: { type: WidgetType; label: string }[] = [
  { type: 'cpu',        label: 'CPU'        },
  { type: 'memory',     label: 'Memory'     },
  { type: 'network',    label: 'Network'    },
  { type: 'containers', label: 'Containers' },
]

const SK = 'dashboard'

const DEFAULT_WIDGETS: Widget[] = [
  { id: 'w-cpu',  type: 'cpu',        cols: 1 },
  { id: 'w-mem',  type: 'memory',     cols: 1 },
  { id: 'w-net',  type: 'network',    cols: 1 },
  { id: 'w-ctr',  type: 'containers', cols: 1 },
]

function loadWidgets(): Widget[] {
  try {
    const raw = localStorage.getItem(SK)
    if (raw) return JSON.parse(raw) as Widget[]
  } catch { /* ignore */ }
  return DEFAULT_WIDGETS.map(w => ({ ...w }))
}

function saveWidgets(ws: Widget[]) {
  localStorage.setItem(SK, JSON.stringify(ws))
}

function pushHist(arr: Ref<number[]>, val: number, hist: number) {
  arr.value.push(val)
  if (arr.value.length > hist) arr.value.shift()
}

export function spark(
  vals: number[],
  lo = 0,
  hi?: number,
): { line: string } {
  if (vals.length < 2) return { line: '' }
  const max = hi ?? Math.max(...vals, 1)
  const min = lo
  const W = 100
  const H = 40
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W
    const y = H - ((v - min) / (max - min || 1)) * H
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return { line: `M${pts.join('L')}` }
}

export function fmtBytes(b: number): string {
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(1) + ' MB/s'
  if (b >= 1024)      return (b / 1024).toFixed(1) + ' KB/s'
  return b + ' B/s'
}

export function fmtMem(b: number): string {
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB'
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(0) + ' MB'
  return (b / 1024).toFixed(0) + ' KB'
}

export function memColor(percent: number): string {
  if (percent > 85) return 'var(--c-accent)'
  if (percent > 65) return 'var(--c-warning)'
  return 'var(--c-success)'
}

export function useDashboardWidgets() {
  const widgets    = ref<Widget[]>(loadWidgets())
  const metrics    = ref<Metrics | null>(null)
  const containers = ref<ContainerStatus[]>([])

  const HIST = 30
  const cpuHist = ref<number[]>([])
  const rxHist  = ref<number[]>([])
  const txHist  = ref<number[]>([])

  let timer: ReturnType<typeof setInterval> | null = null

  async function fetchMetrics() {
    try {
      const m = await trpc.system.metrics.query()
      metrics.value = m as Metrics
      pushHist(cpuHist, m.cpu, HIST)
      pushHist(rxHist,  m.network.rx, HIST)
      pushHist(txHist,  m.network.tx, HIST)
    } catch { /* ignore */ }
  }

  async function fetchContainers() {
    try {
      containers.value = (await trpc.container.app.list.query()) as ContainerStatus[]
    } catch { /* ignore */ }
  }

  onMounted(() => {
    fetchMetrics()
    fetchContainers()
    timer = setInterval(fetchMetrics, 3000)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  const uptimeStr = computed(() => {
    const s = metrics.value?.uptime ?? 0
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return `up ${d}d ${h}h`
    if (h > 0) return `up ${h}h ${m}m`
    return `up ${m}m`
  })

  const ctrRunning = computed(() => containers.value.filter(c => c.status === 'running').length)
  const ctrStopped = computed(() => containers.value.filter(c => c.status === 'stopped').length)
  const ctrError   = computed(() => containers.value.filter(c => c.status === 'error').length)

  function toggleCols(w: Widget) {
    w.cols = w.cols === 1 ? 2 : 1
    saveWidgets(widgets.value)
  }

  function removeWidget(id: string) {
    widgets.value = widgets.value.filter(w => w.id !== id)
    saveWidgets(widgets.value)
  }

  function addWidget(type: WidgetType) {
    const id = `w-${type}-${Date.now()}`
    widgets.value.push({ id, type, cols: 1 })
    saveWidgets(widgets.value)
  }

  return {
    widgets, metrics, containers,
    cpuHist, rxHist, txHist,
    uptimeStr, ctrRunning, ctrStopped, ctrError,
    toggleCols, removeWidget, addWidget,
  }
}
```

- [ ] **Step 2: Refactor `DashboardPanel.vue` to consume it**

Replace the entire `<script setup>` block of `apps/dashboard/src/components/dashboard/DashboardPanel.vue` (lines 1-180) with:

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import SegmentedBar from '../ui/SegmentedBar.vue'
import {
  useDashboardWidgets, CATALOG, spark, fmtBytes, fmtMem, memColor,
} from '../../lib/dashboard-widgets'

const {
  widgets, metrics, containers,
  cpuHist, rxHist, txHist,
  uptimeStr, ctrRunning, ctrStopped, ctrError,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const addOpen = ref(false)

function onAddWidget(type: Parameters<typeof addWidget>[0]) {
  addWidget(type)
  addOpen.value = false
}

// Close add dropdown on outside click
function onDocClick() { addOpen.value = false }
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>
```

Then in the template, change the one call site that used `addWidget` directly to add a widget and close the dropdown in one step — line 213 (`@click.stop="addWidget(cat.type)"`) becomes:

```vue
              @click.stop="onAddWidget(cat.type)"
```

No other template changes — `widgets`, `metrics`, `containers`, `cpuHist`, `rxHist`, `txHist`, `uptimeStr`, `ctrRunning`, `ctrStopped`, `ctrError`, `toggleCols`, `removeWidget`, `CATALOG`, `spark`, `fmtBytes`, `fmtMem`, `memColor` are all still in scope with the same names, just sourced from the composable/import instead of being declared inline.

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 4: Manual smoke test (fullscreen mode unchanged)**

Run the dev server (`pnpm dev` from repo root, or `cd apps/dashboard && pnpm dev` alongside a running backend), log in, stay in fullscreen mode, open the Overview tab: confirm CPU/Memory/Network/Containers widgets render and poll exactly as before, Add/remove/resize still work, and the dropdown still closes on an outside click.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/dashboard-widgets.ts apps/dashboard/src/components/dashboard/DashboardPanel.vue
git commit -m "refactor(dashboard): extract widget logic into useDashboardWidgets composable"
```

---

## Task 9: Remove `dashboard` from desktop-mode `AppId`

**Files:**
- Modify: `apps/dashboard/src/lib/desktop.ts`
- Modify: `apps/dashboard/src/components/desktop/Launchpad.vue`
- Modify: `apps/dashboard/src/components/desktop/DesktopWindow.vue`

**Interfaces:**
- Produces: `AppId = 'files' | 'apps' | 'settings' | 'file-preview'` (breaking change to the type other desktop-mode files already use — this task updates every remaining reference).

- [ ] **Step 1: Update `desktop.ts`**

In `apps/dashboard/src/lib/desktop.ts`:

Change line 3:
```ts
export type AppId = 'files' | 'apps' | 'settings' | 'file-preview'
```

Change `APP_LABEL` (lines 29-35) to drop the `dashboard` entry:
```ts
export const APP_LABEL: Record<AppId, string> = {
  files: 'Files',
  apps: 'Apps',
  settings: 'Settings',
  'file-preview': 'Preview',
}
```

Change `APP_ICON_PATH` (lines 37-43) to drop the `dashboard` entry:
```ts
export const APP_ICON_PATH: Record<AppId, string> = {
  files: 'M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  apps: 'M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  'file-preview': 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
}
```

Change `MULTI_INSTANCE` (line 47) — no `dashboard` reference, leave as-is.

Change `DEFAULT_SIZE` (lines 52-58) to drop the `dashboard` entry:
```ts
const DEFAULT_SIZE: Record<AppId, { w: number; h: number }> = {
  files: { w: 860, h: 560 },
  apps: { w: 760, h: 540 },
  settings: { w: 860, h: 560 },
  'file-preview': { w: 760, h: 560 },
}
```

Change `loadWindows()` (lines 60-69) to drop any stale persisted `dashboard` windows:
```ts
function loadWindows(): DesktopWindow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return (parsed as DesktopWindow[])
          .filter(w => (w.appId as string) !== 'dashboard')
          .map(w => ({ ...w, dirty: false }))
      }
    }
  } catch { /* ignore */ }
  return []
}
```

- [ ] **Step 2: Update `Launchpad.vue`**

In `apps/dashboard/src/components/desktop/Launchpad.vue`, change line 8:
```ts
const APP_IDS: AppId[] = ['files', 'apps', 'settings']
```

- [ ] **Step 3: Update `DesktopWindow.vue`**

In `apps/dashboard/src/components/desktop/DesktopWindow.vue`:
- Remove the import on line 6: `import DashboardPanel from '../dashboard/DashboardPanel.vue'`
- Remove line 201: `<DashboardPanel v-if="win.appId === 'dashboard'" class="h-full" />` (the `v-else-if` chain that follows starts at `FileBrowserPanel`, which already reads `v-else-if="win.appId === 'files'"` — no change needed there, it just becomes the first branch).

- [ ] **Step 4: Typecheck and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors. (If any other file still references `AppId`'s removed `'dashboard'` member, TypeScript will flag it here — fix by removing that reference, there should be none left after this task per the earlier repo-wide grep.)

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/desktop.ts apps/dashboard/src/components/desktop/Launchpad.vue apps/dashboard/src/components/desktop/DesktopWindow.vue
git commit -m "feat(dashboard): remove dashboard as a window-able app in desktop mode"
```

---

## Task 10: `DesktopWidgets.vue` (read-only widget grid for the background)

**Files:**
- Create: `apps/dashboard/src/components/desktop/DesktopWidgets.vue`

**Interfaces:**
- Consumes: `useDashboardWidgets`, `CATALOG`, `spark`, `fmtBytes`, `fmtMem`, `memColor` from `../../lib/dashboard-widgets` (Task 8); `Widget`, `WidgetType` types from the same module.
- Produces: emits `contextmenu-widget: [widget: Widget, event: MouseEvent]` (only for right-clicks on a widget card itself — right-clicks on empty space are deliberately left to bubble up to `DesktopShell.vue`'s own handler, see Task 12) for the parent to open the right-click menu; exposes `addableTypes: ComputedRef<{ type: WidgetType; label: string }[]>` and `addWidget(type: WidgetType)`/`removeWidget(id: string)`/`toggleCols(w: Widget)` via `defineExpose` so the parent's context menu can call them.

- [ ] **Step 1: Write the component**

Create `apps/dashboard/src/components/desktop/DesktopWidgets.vue`. This reuses the exact widget-card markup from `DashboardPanel.vue` (CPU/Memory/Network/Containers branches), minus the toolbar and the hover-revealed per-card controls — those move to the context menu in Task 11.

```vue
<script setup lang="ts">
import { computed } from 'vue'
import SegmentedBar from '../ui/SegmentedBar.vue'
import {
  useDashboardWidgets, CATALOG, spark, fmtBytes, fmtMem, memColor, type Widget, type WidgetType,
} from '../../lib/dashboard-widgets'

defineEmits<{
  'contextmenu-widget': [widget: Widget, event: MouseEvent]
}>()

const {
  widgets, metrics, containers,
  cpuHist, rxHist, txHist,
  ctrRunning, ctrStopped, ctrError,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const addableTypes = computed(() =>
  CATALOG.filter(cat => !widgets.value.some(w => w.type === cat.type))
)

defineExpose({ addableTypes, addWidget, removeWidget, toggleCols })
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
    <div
      v-for="w in widgets" :key="w.id"
      :class="['relative bg-[var(--c-surface-alt)]/90 border border-[var(--c-border)] rounded-2xl p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-2' : 'col-span-1']"
      @contextmenu.prevent.stop="$emit('contextmenu-widget', w, $event)"
    >
      <!-- ---- CPU ---- -->
      <template v-if="w.type === 'cpu'">
        <p class="eyebrow mb-3">CPU</p>
        <div class="flex items-end gap-4 flex-1">
          <div class="flex-shrink-0">
            <span
              class="text-4xl tabular-nums leading-none text-[var(--c-text-display)]"
              style="font-family: var(--font-display)"
            >{{ metrics?.cpu ?? '—' }}</span>
            <span class="text-lg text-[var(--c-text-3)] ml-0.5">%</span>
          </div>
          <div class="flex-1 min-w-0">
            <svg
              v-if="cpuHist.length >= 2"
              viewBox="0 0 100 40"
              preserveAspectRatio="none"
              class="w-full h-10"
            >
              <path :d="spark(cpuHist, 0, 100).line" fill="none" stroke="var(--c-accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
      </template>

      <!-- ---- Memory ---- -->
      <template v-else-if="w.type === 'memory'">
        <p class="eyebrow mb-3">Memory</p>
        <div class="flex-1 flex flex-col justify-between">
          <div class="flex items-baseline justify-between mb-3">
            <span class="text-2xl font-bold text-[var(--c-text-3)] tabular-nums leading-none">
              {{ metrics ? fmtMem(metrics.memory.used) : '—' }}
            </span>
            <span class="text-xs text-[var(--c-text-3)]">
              of {{ metrics ? fmtMem(metrics.memory.total) : '—' }}
            </span>
          </div>
          <div class="space-y-1.5">
            <SegmentedBar
              :percent="metrics?.memory.percent ?? 0"
              :color="memColor(metrics?.memory.percent ?? 0)"
              height="compact"
            />
            <p class="text-xs text-[var(--c-text-3)] tabular-nums">{{ metrics?.memory.percent ?? 0 }}% used</p>
          </div>
        </div>
      </template>

      <!-- ---- Network ---- -->
      <template v-else-if="w.type === 'network'">
        <p class="eyebrow mb-3">Network</p>
        <div class="flex-1 flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="space-y-0.5">
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-success)]">↓ rx</span>
                <span class="text-sm font-mono text-[var(--c-text-1)]">{{ metrics ? fmtBytes(metrics.network.rx) : '—' }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] font-semibold text-[var(--c-accent)] uppercase tracking-widest">↑ tx</span>
                <span class="text-sm font-mono text-[var(--c-text-1)]">{{ metrics ? fmtBytes(metrics.network.tx) : '—' }}</span>
              </div>
            </div>
            <div class="flex-1 min-w-0 ml-4">
              <svg
                v-if="rxHist.length >= 2 || txHist.length >= 2"
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
                class="w-full h-10"
              >
                <path
                  v-if="rxHist.length >= 2"
                  :d="spark(rxHist).line"
                  fill="none" stroke="var(--c-success)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
                />
                <path
                  v-if="txHist.length >= 2"
                  :d="spark(txHist).line"
                  fill="none" stroke="var(--c-accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"
                />
              </svg>
            </div>
          </div>
        </div>
      </template>

      <!-- ---- Containers ---- -->
      <template v-else-if="w.type === 'containers'">
        <p class="eyebrow mb-3">Containers</p>
        <div class="flex-1 flex items-center gap-6">
          <div class="text-center">
            <p class="text-3xl font-bold tabular-nums leading-none text-[var(--c-success)]">{{ ctrRunning }}</p>
            <p class="text-[10px] text-[var(--c-text-3)] uppercase tracking-widest mt-1">Running</p>
          </div>
          <div class="text-center">
            <p class="text-3xl font-bold text-[var(--c-text-3)] tabular-nums leading-none">{{ ctrStopped }}</p>
            <p class="text-[10px] text-[var(--c-text-3)] uppercase tracking-widest mt-1">Stopped</p>
          </div>
          <div class="text-center">
            <p class="text-3xl font-bold tabular-nums leading-none" :class="ctrError > 0 ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]'">{{ ctrError }}</p>
            <p class="text-[10px] text-[var(--c-text-3)] uppercase tracking-widest mt-1">Error</p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/DesktopWidgets.vue
git commit -m "feat(dashboard): add DesktopWidgets read-only background widget grid"
```

---

## Task 11: `WallpaperPicker.vue` (color/image picker modal)

**Files:**
- Create: `apps/dashboard/src/components/desktop/WallpaperPicker.vue`

**Interfaces:**
- Consumes: `useWallpaper` (Task 7), `Modal` (`../ui/Modal.vue`).
- Produces: emits `close: []`.

- [ ] **Step 1: Write the component**

Create `apps/dashboard/src/components/desktop/WallpaperPicker.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { useWallpaper } from '../../lib/wallpaper'

const emit = defineEmits<{ close: [] }>()
const { setColor, setImage, clear } = useWallpaper()

const SWATCHES = ['#d71921', '#f97316', '#3b82f6', '#22c55e', '#a855f7', '#1a1a1a', '#666666', '#f5f5f5']

const customColor = ref('#d71921')
const error = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function pickColor(value: string) {
  error.value = null
  try {
    await setColor(value)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to set color'
  }
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = null
  try {
    await setImage(file)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to upload image'
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function reset() {
  error.value = null
  try {
    await clear()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to reset wallpaper'
  }
}
</script>

<template>
  <Modal panel-class="w-full max-w-sm" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Change wallpaper</h3>
    </template>

    <div class="p-6 space-y-5">
      <div>
        <p class="eyebrow mb-2">Color</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="c in SWATCHES" :key="c"
            :style="{ backgroundColor: c }"
            class="w-8 h-8 rounded-lg border border-[var(--c-border-strong)]"
            @click="pickColor(c)"
          />
          <input
            v-model="customColor"
            type="color"
            class="w-8 h-8 rounded-lg border border-[var(--c-border-strong)] cursor-pointer"
            @change="pickColor(customColor)"
          />
        </div>
      </div>

      <div>
        <p class="eyebrow mb-2">Image</p>
        <button
          class="w-full px-3 py-2 bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)] text-[var(--c-text-2)] text-sm rounded-lg hover:bg-[var(--c-hover)] transition-colors"
          @click="fileInput?.click()"
        >
          Upload image...
        </button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="onFileChange" />
      </div>

      <p v-if="error" class="status-text text-[var(--c-accent)] text-xs">[ERR] {{ error }}</p>
    </div>

    <template #footer>
      <button
        class="px-3 py-1.5 text-sm text-[var(--c-text-2)] hover:bg-[var(--c-hover)] rounded-lg transition-colors"
        @click="reset"
      >
        Reset to default
      </button>
    </template>
  </Modal>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/desktop/WallpaperPicker.vue
git commit -m "feat(dashboard): add WallpaperPicker color/image modal"
```

---

## Task 12: Wire it all into `DesktopShell.vue`

**Files:**
- Modify: `apps/dashboard/src/components/desktop/DesktopShell.vue`
- Modify: `apps/dashboard/src/components/desktop/DesktopWindow.vue`

**Interfaces:**
- Consumes: `useWallpaper` (Task 7), `DesktopWidgets` (Task 10), `WallpaperPicker` (Task 11), `Widget`/`WidgetType` types (`../../lib/dashboard-widgets`).

- [ ] **Step 1: Stop contextmenu events from bubbling out of windows**

`DesktopShell.vue`'s root div is about to get its own `contextmenu` handler (Step 2) for
right-clicks on empty desktop space. Without this step, a right-click inside any window
(e.g. the file browser's own context menu, which calls `.prevent` but not `.stop`) would
bubble past the window and ALSO trigger the new empty-desktop menu, opening both at once.

In `apps/dashboard/src/components/desktop/DesktopWindow.vue`, change the root element's
opening tag (line 125-130) to stop contextmenu propagation at the window boundary:

```vue
  <div
    class="absolute flex flex-col rounded-xl overflow-hidden bg-[var(--c-surface)] border"
    :class="focused ? 'border-[var(--c-accent)]' : 'border-[var(--c-border-strong)]'"
    :style="{ left: win.x + 'px', top: win.y + 'px', width: win.w + 'px', height: win.h + 'px', zIndex: win.zIndex }"
    @pointerdown="focusWindow(win.id)"
    @contextmenu.stop
  >
```

(Only `.stop`, not `.prevent` — this must not block whatever a window's own content does
with right-click, e.g. `FileBrowserPanel.vue`'s own context menu, which still calls
`.prevent` itself. It only stops the event from bubbling further up to `DesktopShell.vue`.)

- [ ] **Step 2: Rewrite `DesktopShell.vue`**

Replace the full contents of `apps/dashboard/src/components/desktop/DesktopShell.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDesktop } from '../../lib/desktop'
import { useWallpaper } from '../../lib/wallpaper'
import type { Widget, WidgetType } from '../../lib/dashboard-widgets'
import DesktopWindow from './DesktopWindow.vue'
import DesktopWidgets from './DesktopWidgets.vue'
import WallpaperPicker from './WallpaperPicker.vue'

const { windows, clampToViewport } = useDesktop()
const { backgroundStyle } = useWallpaper()

const rootRef = ref<HTMLDivElement | null>(null)
const widgetsRef = ref<InstanceType<typeof DesktopWidgets> | null>(null)
const bounds = ref({ w: 0, h: 0 })
const showWallpaperPicker = ref(false)

type CtxMenu =
  | { kind: 'empty'; x: number; y: number }
  | { kind: 'widget'; x: number; y: number; widget: Widget }

const ctxMenu = ref<CtxMenu | null>(null)

function openCtx(menu: CtxMenu) {
  ctxMenu.value = { ...menu, x: Math.min(menu.x, window.innerWidth - 200), y: Math.min(menu.y, window.innerHeight - 240) }
}
function closeCtx() { ctxMenu.value = null }

// Fires for any right-click that reaches the root div without being stopped
// first — i.e. genuinely empty desktop space. Widget cards stop propagation
// themselves (see DesktopWidgets.vue) and emit contextmenu-widget instead;
// windows stop propagation in DesktopWindow.vue (Step 1 above).
function onContextmenuEmpty(e: MouseEvent) {
  openCtx({ kind: 'empty', x: e.clientX, y: e.clientY })
}
function onContextmenuWidget(widget: Widget, e: MouseEvent) {
  openCtx({ kind: 'widget', x: e.clientX, y: e.clientY, widget })
}

function addWidgetFromMenu(type: WidgetType) {
  widgetsRef.value?.addWidget(type)
  closeCtx()
}
function removeWidgetFromMenu(id: string) {
  widgetsRef.value?.removeWidget(id)
  closeCtx()
}
function toggleColsFromMenu(w: Widget) {
  widgetsRef.value?.toggleCols(w)
  closeCtx()
}
function openWallpaperPicker() {
  showWallpaperPicker.value = true
  closeCtx()
}

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
  <div
    ref="rootRef"
    class="relative w-full h-full overflow-hidden bg-[var(--c-bg)]"
    :style="backgroundStyle"
    @contextmenu.prevent="onContextmenuEmpty"
  >
    <DesktopWidgets
      ref="widgetsRef"
      @contextmenu-widget="onContextmenuWidget"
    />

    <DesktopWindow
      v-for="w in visibleWindows"
      :key="w.id"
      :win="w"
      :focused="isFocused(w.id)"
      :bounds="bounds"
    />

    <Teleport to="body">
      <template v-if="ctxMenu">
        <div class="fixed inset-0 z-40" @click="closeCtx" @contextmenu.prevent="closeCtx" />
        <div
          class="fixed z-50 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl overflow-hidden py-1.5 min-w-[180px]"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click.stop
        >
          <template v-if="ctxMenu.kind === 'empty'">
            <button class="ctx-item" @click="openWallpaperPicker">Change wallpaper...</button>
            <div class="h-px bg-[var(--c-border-strong)] mx-2 my-1" />
            <p class="px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--c-text-3)]">Add widget</p>
            <button
              v-for="cat in widgetsRef?.addableTypes ?? []" :key="cat.type"
              class="ctx-item"
              @click="addWidgetFromMenu(cat.type)"
            >
              {{ cat.label }}
            </button>
          </template>
          <template v-else>
            <button class="ctx-item" @click="toggleColsFromMenu(ctxMenu.widget)">
              {{ ctxMenu.widget.cols === 1 ? 'Expand' : 'Shrink' }}
            </button>
            <button class="ctx-item ctx-item-danger" @click="removeWidgetFromMenu(ctxMenu.widget.id)">Remove widget</button>
          </template>
        </div>
      </template>
    </Teleport>

    <WallpaperPicker v-if="showWallpaperPicker" @close="showWallpaperPicker = false" />
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.ctx-item {
  @apply w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-[var(--c-text-2)]
         hover:bg-[var(--c-hover)] transition-colors text-left;
}
.ctx-item-danger {
  color: var(--c-accent);
}
.ctx-item-danger:hover {
  background-color: var(--c-accent-subtle);
}
</style>
```

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/desktop/DesktopShell.vue apps/dashboard/src/components/desktop/DesktopWindow.vue
git commit -m "feat(dashboard): wire wallpaper and background widgets into DesktopShell"
```

---

## Task 13: Full verification pass

**Files:**
- None to modify — this is a verification-only task confirming the whole feature end-to-end.

- [ ] **Step 1: Full backend typecheck**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full frontend build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 3: Manual pass (needs a running backend)**

Start backend + dashboard dev servers, log in, enable Desktop mode:
1. Confirm Launchpad shows exactly 3 icons (Files, Apps, Settings) — no Overview/dashboard icon.
2. Confirm the desktop background shows the widget grid (CPU/Memory/Network/Containers) with no toolbar and no hover controls.
3. Right-click empty desktop space → "Change wallpaper..." → pick a swatch color → background updates immediately, modal stays open, reopen later confirms persistence after reload.
4. In the same menu, "Upload image..." → pick a small PNG/JPEG/WEBP → background switches to the image; reload the page → image wallpaper persists (re-fetched via a fresh token).
5. "Reset to default" → background returns to flat `var(--c-bg)`.
6. Right-click a widget card → "Expand"/"Shrink" toggles its column span; "Remove widget" removes it; right-click empty space → "Add widget" submenu offers it back (only the missing one is listed).
7. Switch back to fullscreen mode → Overview tab still shows the full toolbar + hover controls exactly as before this feature.
8. Open Files/Apps/Settings windows on the desktop — confirm they still drag/resize/minimize/maximize/close normally, layered above the widgets/wallpaper.

- [ ] **Step 4: No commit needed for this task** (verification only).
