#!/usr/bin/env bash
# Tests install_restic from scripts/install.sh without touching the network:
# the release is served from a temp dir through a file:// URL.
set -uo pipefail

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "SKIP restic-download test: needs x86_64"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

warn() { echo "WARN $*"; }
sed -n '/^RESTIC_VERSION=/,/^}/p' "$ROOT/scripts/install.sh" > "$TMP/func.sh"
if ! grep -q '^install_restic()' "$TMP/func.sh"; then
  echo "FAIL install_restic not found in scripts/install.sh"
  exit 1
fi

# Fake release: a script that reports the pinned version, compressed like upstream.
SRC="$TMP/src/v0.19.1"
mkdir -p "$SRC"
printf '#!/bin/sh\necho "restic 0.19.1 compiled with go1.25 on linux/amd64"\n' > "$TMP/restic"
bzip2 -c "$TMP/restic" > "$SRC/restic_0.19.1_linux_amd64.bz2"
GOOD_SUM="$(sha256sum "$SRC/restic_0.19.1_linux_amd64.bz2" | cut -d' ' -f1)"

export RESTIC_URL_BASE="file://$TMP/src"
export RESTIC_DEST="$TMP/dest/restic"
FAILED=0
check() { if ! eval "$2"; then echo "FAIL $1"; FAILED=1; else echo "ok   $1"; fi; }

# shellcheck disable=SC1091
source "$TMP/func.sh"

# 1. Wrong checksum (the pinned value does not match the fake file).
out="$(install_restic)"; rc=$?
check "wrong checksum returns 1" '[[ $rc -eq 1 ]]'
check "wrong checksum reports a mismatch" '[[ "$out" == *"does not match"* ]]'
check "wrong checksum installs nothing" '[[ ! -e "$RESTIC_DEST" ]]'

# 2. Right checksum.
RESTIC_SHA256_amd64="$GOOD_SUM"
out="$(install_restic)"; rc=$?
check "right checksum returns 0" '[[ $rc -eq 0 ]]'
check "right checksum installs an executable" '[[ -x "$RESTIC_DEST" ]]'

# 3. Same version again: no download needed.
rm -rf "$TMP/src"
out="$(install_restic)"; rc=$?
check "already installed returns 0 without downloading" '[[ $rc -eq 0 && -z "$out" ]]'

exit $FAILED
