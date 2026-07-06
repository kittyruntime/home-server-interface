# Architecture

Home Server Interface is a pnpm monorepo split into a few small, single-purpose
pieces. The guiding principle is **privilege isolation**: the process exposed to
the network holds no special rights, and anything requiring root is delegated to
an isolated worker over a message broker.

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
| **backend** (`apps/backend`) | `app` | unprivileged app user | Serves the API and the built dashboard. Owns auth, the database, and business logic. Holds **no** root rights. |
| **root-worker** (`apps/root-worker`, Go) | `app-root-worker` | `root` | Executes privileged operations only: ownership-preserving file ops, `chmod`/`chown`, user-impersonated writes, disk/RAID/LVM/mount management, and Samba config. |
| **NATS** | `app-nats` | service user | JetStream message broker linking backend ↔ root-worker via request/reply. |

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

**Root worker** (`apps/root-worker`, Go ≥ 1.21)
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

`auth` · `user` · `role` · `permission` · `place` · `fs` · `container` ·
`system` (disks/RAID/LVM/mounts) · `sharing` (SMB) · `audit` · `tasks`
(background jobs) · `update` · `wallpaper`

## Permissions model

- Every user maps to an individual **Linux account**, so filesystem permissions
  are enforced at the OS level (writes are impersonated by the root-worker).
- **Roles** carry a permission matrix over Users, Places, Files, Containers and
  System categories; users are assigned to roles.
- **Administrators bypass** all permission checks.
- Every privileged action is written to the **audit log**.

## Request lifecycle (example: copy a large folder)

1. Dashboard calls `fs.copy` over tRPC.
2. Backend authenticates the JWT, checks the caller's permissions, and enqueues a
   background **task**, returning a job id.
3. Backend publishes a copy request to NATS; the root-worker performs the
   ownership-preserving copy as root.
4. The dashboard polls `tasks` for progress and shows a notification on
   completion — no open tab required.
