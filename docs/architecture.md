# Architecture

Home Server Interface is a pnpm monorepo split into a few small, single-purpose
pieces. The guiding principle is **privilege isolation**: the process exposed to
the network holds no special rights, and anything requiring root is delegated to
an isolated worker over a message broker.

## Declarative configuration

**HSI manages your server, not owns it. The DB describes HSI; files describe the server.**

1. Server configuration lives in files at each tool's native location — never in a DB table.
2. Files stay readable, backupable and hand-editable; HSI re-reads manual edits and flags what it
   cannot represent (nothing is silently dropped).
3. HSI only writes its own dedicated files — never a package-owned file. Use `conf.d`/drop-in
   patterns when the tool offers them.
4. Editing is not applying: edits write the file; applying to the system is an explicit step
   (validated first).
5. The DB keeps only HSI-territorial data (users, permissions, Places, audit, preferences) and at
   most in-memory observed state.
6. The root worker executes, never decides: it receives a precise operation on a file, not a
   definition.

Current file locations:

| Domain | File | Status |
|---|---|---|
| Container apps | `/opt/containers/<app>/compose.yaml` (Compose is the source of truth) | done |
| Samba | `/etc/nasui/samba/smb.conf` (dedicated file, systemd drop-in) | file exists; re-read planned |
| RAID / storage | `mdadm.conf` + HSI file | planned |

## Runtime processes

Three long-running processes, each a systemd unit in production:

```
        HTTP (9001)                 NATS JetStream                syscalls
Browser ───────────▶  backend  ◀──────────────────────▶  root-worker  ───────▶ OS
                      (app user)      request/reply         (root)
                         │
                         ▼
                    SQLite (Prisma)
```

| Process | Unit | Runs as | Responsibility |
|---|---|---|---|
| **backend** (`apps/backend`) | `hsi` | unprivileged app user | Serves the API and the built dashboard. Owns auth, the database, and business logic. Holds **no** root rights. |
| **root-worker** (`apps/root-worker`, Go) | `hsi-root-worker` | `root` | Executes privileged operations only: ownership-preserving file ops, `chmod`/`chown`, user-impersonated writes, disk/RAID/LVM/mount management, and Samba config. |
| **NATS** | `hsi-nats` | service user | JetStream message broker linking backend ↔ root-worker via request/reply. |

The backend never shells out as root. When it needs a privileged action it
publishes a request on NATS; the root-worker consumes it, performs the syscall,
and replies. Heavy work (large copies/moves, upload assembly) is run as a
**background job** the UI polls to completion — no browser tab needs to stay open.

## Tech stack

**Backend** (`apps/backend`)
- [Fastify](https://fastify.dev) HTTP server, serving the API and the static dashboard
- [tRPC](https://trpc.io) for end-to-end typed RPC (routers in `src/trpc/routers/`)
- [Prisma](https://www.prisma.io) ORM over **SQLite**
- `jsonwebtoken` (auth) + `bcryptjs` (password hashing)
- [NATS](https://nats.io) client for talking to the root-worker

**Root worker** (`apps/root-worker`, Go ≥ 1.25)
- One file per domain: `fs.go`, `disk.go`, `docker.go`, `sharing.go`, `userctx.go`
- Subscribes to NATS subjects and performs the actual privileged syscalls

**Dashboard** (`apps/dashboard`)
- [Vue 3.5](https://vuejs.org) (`<script setup>` SFCs) + [vue-router](https://router.vuejs.org)
- [Tailwind CSS v4](https://tailwindcss.com) with a token-based design system (see [design-system.md](design-system.md))
- tRPC client for typed calls to the backend
- Chart.js (metrics), CodeMirror (file preview/edit), lazy-loaded per app

**Shared packages**
- `packages/database` — Prisma schema (`prisma/schema/`) and generated client
- `packages/shared-types` — types shared between backend and dashboard

## tRPC routers

The API surface is the set of routers in `apps/backend/src/trpc/routers/`, each
mapping to a feature area:

`auth` · `user` · `permission` · `place` · `fs` · `container` ·
`system` (metrics, sysinfo) · `storage` (disks/RAID/LVM/mounts) ·
`sharing` (SMB) · `audit` · `tasks` (background jobs) · `update` · `wallpaper`

## Places

A **Place** (`packages/database/prisma/schema/place.prisma`) is a name HSI gives to an
absolute path that already exists on the server — nothing more. Creating one doesn't
move data, format anything, or create a new storage unit; it just registers `{ name,
path }` so the rest of HSI has something to point at.

Everything else attaches to that record:

- **Permissions** — Read/Write/Delete/Share, per user or per group, are granted against
  a Place (see [Permissions model](#permissions-model) below).
- **Sharing** — a Place can optionally have one `Share` (SMB), which exposes its path
  over Samba under the permissions already set on the Place.
- **The file manager** — browsing "start" at a Place; HSI never lets you browse or
  share a path that isn't backed by one.

A Place is a pointer with policy attached, not a storage abstraction: it doesn't care
whether the path underneath is a plain directory, a mounted RAID array, or an LVM
logical volume — that's decided one layer down, in Storage. Deleting a Place removes
the HSI-side registration (permissions, share); it never touches the files at that path.

## Permissions model

- Every user maps to an individual **Linux account**, so filesystem permissions
  are enforced at the OS level (writes are impersonated by the root-worker).
- Access to a **place** (a filesystem root) is granted per user or per group as
  Read/Write/Delete/Share, via `permission.ts`.
- Two account-level flags grant broader access: **Admin** (bypasses all permission
  checks) and **User manager** (can create/edit/delete other user accounts, but not
  grant admin/user-manager/capabilities on them).
- **Capabilities** grant a non-admin account a specific admin-adjacent power without
  making them a full admin — e.g. the `storage` capability unlocks disk/RAID/LVM/
  partition management. Admin implies every capability. New capabilities are added
  by inserting rows, not by adding new account-level flags.
- Every privileged action is written to the **audit log**.

## Request lifecycle (example: copy a large folder)

1. Dashboard calls `fs.copy` over tRPC.
2. Backend authenticates the JWT, checks the caller's permissions, and enqueues a
   background **task**, returning a job id.
3. Backend publishes a copy request to NATS; the root-worker performs the
   ownership-preserving copy as root.
4. The dashboard polls `tasks` for progress and shows a notification on
   completion — no open tab required.
