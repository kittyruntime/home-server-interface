#!/usr/bin/env bash
# Called daily by brume-update-check.timer to check for a new release.
# Writes .update-check.json into the install directory.
set -euo pipefail

REPO="kittyruntime/brume"
INSTALL_DIR="${INSTALL_DIR:-/opt/brume}"

latest=$(curl -fsSL --max-time 15 \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -oP '"tag_name":\s*"\K[^"]+' || true)

[[ -n "$latest" ]] || exit 0

printf '{"latestVersion":"%s","checkedAt":"%s"}\n' \
  "$latest" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$INSTALL_DIR/.update-check.json"
