#!/usr/bin/env bash
# Asserts the release signing public key copies are byte-identical.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if cmp -s "$ROOT/scripts/release-signing.pub" "$ROOT/apps/root-worker/release-signing.pub"; then
  echo "PASS signing key copies match"
else
  echo "FAIL scripts/release-signing.pub and apps/root-worker/release-signing.pub differ"
  exit 1
fi
