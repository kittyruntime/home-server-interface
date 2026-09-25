# Development

## Prerequisites

- **Node.js 20.19+ or 22.12+** and **pnpm**
- **Go ≥ 1.25** (for the root-worker)
- **Docker**, to run the local NATS server (or a `nats-server` binary with JetStream)
- `curl`, `openssl`

## Install dependencies

```bash
pnpm install
```

The Prisma client is generated automatically before builds and typechecks. If
you change the schema (`packages/database/prisma/schema/`), you can regenerate
it explicitly:

```bash
pnpm --filter @app/database db:generate
```

Other database scripts (from `packages/database`): `db:push`, `db:migrate`,
`db:deploy`, `db:seed`.

## Run the dev servers

A local stack has four processes: NATS, the root worker, the backend and the
dashboard.

### 1. Database

```bash
pnpm --filter @app/database db:push
pnpm --filter @app/database db:seed   # creates the admin / admin account
```

### 2. Backend environment

```bash
cat > apps/backend/.env << 'END'
JWT_SECRET=dev-secret
NATS_URL=nats://127.0.0.1:4222
NATS_USER=backend
NATS_PASS=backend-dev
END
```

`apps/backend/.env` is git-ignored. See [configuration.md](configuration.md) for
every environment variable.

### 3. NATS (terminal 1)

```bash
docker compose up
```

`docker-compose.yaml` starts NATS with JetStream using the repository's
`nats.conf`, which defines the development accounts `backend` / `backend-dev`
and `worker` / `worker-dev`. It listens on `127.0.0.1:4222` only.

### 4. Root worker (terminal 2, needs root)

```bash
cd apps/root-worker
go build -o root-worker .
sudo NATS_URL=nats://127.0.0.1:4222 NATS_USER=worker NATS_PASS=worker-dev ./root-worker
```

The worker performs privileged operations (disks, users, Samba) on the machine
it runs on. Prefer a disposable VM over your workstation.

### 5. Backend (terminal 3)

```bash
pnpm --filter @app/backend dev      # vite-node, serves the API on :9001
```

### 6. Dashboard (terminal 4)

```bash
pnpm --filter @app/dashboard dev    # Vite dev server with hot reload on :5173
```

Open http://localhost:5173 and log in with `admin / admin`. `pnpm dev` runs the
backend and dashboard dev scripts in parallel if you prefer one terminal for
both.

The backend reads `DASHBOARD_PATH` to serve built assets; in dev the dashboard is
served by Vite instead.

## Build & verify

```bash
pnpm verify  # lint + typecheck + backend/Go tests + production builds
```

Run individual gates with `pnpm lint`, `pnpm typecheck`, `pnpm test`, or
`pnpm build` (`pnpm lint:fix` applies safe ESLint fixes).

CI enforces ESLint, TypeScript/Vue typechecks, backend security tests, Go tests,
`gofmt`, `go vet`, i18n checks, and production builds. The ESLint config
(`eslint.config.js`) uses the correctness-focused rules only (Vue `flat/essential`
+ typescript-eslint recommended) and deliberately leaves template formatting to the
editor.

The same canonical backend build is used by local development, CI, source
installation, and release packaging.

### Runtime smoke test

To exercise the built app end-to-end, point the backend at the built dashboard
and boot it:

```bash
pnpm --filter @app/dashboard build
cd apps/backend && DASHBOARD_PATH=../dashboard/dist pnpm dev
# then: curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9001/
```

## Monorepo layout

```
apps/
  backend/       Fastify + tRPC API, serves the dashboard      (@app/backend)
  dashboard/     Vue 3 + Tailwind v4 SPA                        (@app/dashboard)
  root-worker/   Go privileged worker (NATS request/reply)
packages/
  database/      Prisma schema + generated client              (@app/database)
  shared-types/  Types shared backend ↔ dashboard              (@app/shared-types)
scripts/
  install.sh     Install/update on a Linux host
  release.sh     Cut a release (bump, changelog, tag, push)
  setup-sudo.sh  Dev helper
docs/            This documentation
```

Dashboard source of note:
- `src/components/ui/Modal.vue` — the shared modal (animation, window-scoping, Escape stack)
- `src/components/storage/dialogs/` — shared device/destroy dialogs reused by all storage sections
- `src/lib/` — composables and helpers (`confirm.ts`, `escLayer.ts`, `desktop.ts`, `trpc.ts`, …)
- `src/style.css` — design tokens and shared utility classes

## Release process

Releases are **manual and batched** — group related changes, then cut one
release. Never release automatically.

1. Add your changes under `## [Unreleased]` in `CHANGELOG.md`.
2. Ensure the working tree is clean and you are on `main`.
3. Run the release script with the new SemVer version:

   ```bash
   ./scripts/release.sh 1.28.1
   ```

   It bumps `package.json`, moves the `[Unreleased]` notes under the new version,
   commits, tags `v<version>`, and pushes `main` + the tag — which triggers the
   GitHub Actions release workflow.

The script refuses to run on a dirty tree, off `main`, with an existing tag, or
with an empty `[Unreleased]` section.
