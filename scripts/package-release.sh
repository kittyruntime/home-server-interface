#!/usr/bin/env bash
# Usage: scripts/package-release.sh <version> [app-name]
# Packs an already built tree (runtime dependencies, root-worker, backend and
# dashboard builds) into <app>-v<version>-linux-amd64.tar.gz, the layout
# install.sh expects. Used by the release workflow and the VM tests.
set -euo pipefail

VERSION="${1:?usage: $0 <version> [app-name]}"
VERSION="${VERSION#v}"
APP_NAME="${2:-${APP_NAME:-hsi}}"
cd "$(git rev-parse --show-toplevel)"

ARCHIVE="${APP_NAME}-v${VERSION}-linux-amd64.tar.gz"
tar -czf "$ARCHIVE" \
  --transform "flags=rh;s|^apps/backend/dist/server\.js$|server.js|" \
  --transform "flags=rh;s|^apps/dashboard/dist|public|" \
  --transform "flags=rh;s|^apps/root-worker/root-worker$|bin/${APP_NAME}-worker|" \
  --transform "flags=rh;s|^packages/database|database|" \
  --transform "flags=rh;s|^packages/compose|compose|" \
  --transform "flags=rh;s|^runtime/node_modules|node_modules|" \
  --transform "flags=rh;s|^|${APP_NAME}-v${VERSION}/|" \
  apps/root-worker/root-worker \
  apps/backend/dist/server.js \
  apps/dashboard/dist \
  packages/database/package.json \
  packages/database/prisma.config.ts \
  packages/database/prisma \
  packages/database/src \
  packages/compose/package.json \
  packages/compose/src \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  LICENSE \
  CHANGELOG.md \
  README.md \
  runtime/package.json \
  runtime/package-lock.json \
  runtime/node_modules \
  scripts/install.sh
echo "$ARCHIVE"
