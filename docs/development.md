# Development

## Prerequisites

- **Node.js ≥ 20** and **pnpm**
- **Go ≥ 1.21** (for the root-worker)
- A running **NATS** server with JetStream (the install script sets one up; for
  local dev you can run `nats-server -js`)
- `curl`, `openssl`

## Install dependencies

```bash
pnpm install
```

The Prisma client is generated on install. If you change the schema
(`packages/database/prisma/schema/`), regenerate it:

```bash
pnpm --filter @app/database db:generate
```

Other database scripts (from `packages/database`): `db:push`, `db:migrate`,
`db:deploy`, `db:seed`.

## Run the dev servers

```bash
pnpm dev          # runs every workspace's dev script in parallel
```

Or per workspace:

```bash
pnpm --filter @app/dashboard dev    # Vite dev server (hot reload)
pnpm --filter @app/backend dev      # vite-node, serves API on :9001
```

The backend reads `DASHBOARD_PATH` to serve built assets; in dev the dashboard is
served by Vite instead. See [configuration.md](configuration.md) for the full
list of environment variables (`JWT_SECRET`, `NATS_URL`, …).

The root-worker is a Go binary:

```bash
cd apps/root-worker && go build -o root-worker . && ./root-worker
```

## Build & verify

There is **no unit-test suite yet**; verification is build + typecheck.

```bash
pnpm -r build                              # build all workspaces
pnpm --filter @app/dashboard exec vue-tsc -b   # dashboard type check
cd apps/root-worker && go build ./...      # root-worker compiles
```

CI (`.github/workflows/ci.yml`) builds the root-worker, generates the Prisma
client, bundles the backend with esbuild, and builds the dashboard on every push
and PR.

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
