#!/usr/bin/env bash
# Usage: scripts/build-release.sh <version>
# Builds the release archive of this machine's architecture (amd64 or arm64)
# from a checked out tree with its pnpm dependencies installed: locked runtime
# dependencies with their native modules and Prisma engines, root-worker,
# backend and dashboard, then packs them (scripts/package-release.sh). Prints
# the archive name on the last line. Used by the release workflow, the VM
# tests and the arm64 CI job, so every archive is built the same way.
set -euo pipefail

VERSION="${1:?usage: $0 <version>}"
VERSION="${VERSION#v}"
cd "$(git rev-parse --show-toplevel)"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 PRISMA_TARGET=debian-openssl-3.0.x ;;
  aarch64|arm64) ARCH=arm64 PRISMA_TARGET=linux-arm64-openssl-3.0.x ;;
  *) echo "No release archive for $(uname -m)" >&2; exit 1 ;;
esac

{
  pnpm --filter @app/database db:generate
  test -s packages/database/src/generated/prisma/client.ts

  npm ci --prefix runtime --omit=dev --no-audit --no-fund
  PRISMA_CLI_BINARY_TARGETS="$PRISMA_TARGET" \
    node runtime/node_modules/@prisma/engines/scripts/postinstall.js
  test -x "runtime/node_modules/@prisma/engines/schema-engine-$PRISMA_TARGET"
  test -s runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node

  (cd apps/root-worker && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
    go build -ldflags "-s -w -X main.buildVersion=v${VERSION}" -o root-worker .)

  pnpm --filter @app/backend build
  echo "VITE_API_URL=/trpc" > apps/dashboard/.env.production
  pnpm --filter @app/dashboard run build
} >&2

scripts/package-release.sh "$VERSION"
