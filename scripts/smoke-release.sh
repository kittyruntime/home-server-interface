#!/usr/bin/env bash
# Usage: scripts/smoke-release.sh <archive>
# Checks a release archive on the machine it was built for, without
# installing it: the worker is a binary of this architecture, and the bundled
# native pieces (better-sqlite3, the Prisma schema engine) load and run here.
set -euo pipefail

ARCHIVE="${1:?usage: $0 <archive>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP" --strip-components=1

case "$(uname -m)" in
  x86_64|amd64) MACHINE=x86-64 ;;
  aarch64|arm64) MACHINE=aarch64 ;;
  *) echo "Unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

worker=$(ls "$TMP"/bin/*-worker)
file -b "$worker" | grep -q "$MACHINE" \
  || { echo "The worker is not a $MACHINE binary: $(file -b "$worker")" >&2; exit 1; }

(cd "$TMP" && node -e '
  const Database = require("better-sqlite3")
  const db = new Database(":memory:")
  if (db.prepare("select 1 + 1 as n").get().n !== 2) process.exit(1)
')

engine=$(ls "$TMP"/node_modules/@prisma/engines/schema-engine-*)
"$engine" --version >/dev/null

test -s "$TMP/server.js"
test -s "$TMP/public/index.html"
echo "Release archive OK on $(uname -m): $(basename "$ARCHIVE")"
