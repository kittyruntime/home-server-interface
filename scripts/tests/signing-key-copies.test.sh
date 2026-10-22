#!/usr/bin/env bash
# Asserts the release signing public key copies are byte-identical: the file in
# scripts/, the one the worker embeds and the RELEASE_SIGNING_PUB heredoc of
# scripts/install.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0

if cmp -s "$ROOT/scripts/release-signing.pub" "$ROOT/apps/root-worker/release-signing.pub"; then
  echo "PASS signing key copies match"
else
  echo "FAIL scripts/release-signing.pub and apps/root-worker/release-signing.pub differ"
  FAILED=1
fi

sed -n "/^RELEASE_SIGNING_PUB=\$(cat <<'PEM'\$/,/^PEM\$/p" "$ROOT/scripts/install.sh" | sed '1d;$d' > "$TMP/heredoc.pub"
if [[ -s "$TMP/heredoc.pub" ]] && cmp -s "$ROOT/scripts/release-signing.pub" "$TMP/heredoc.pub"; then
  echo "PASS install.sh RELEASE_SIGNING_PUB matches"
else
  echo "FAIL the RELEASE_SIGNING_PUB heredoc of scripts/install.sh differs from scripts/release-signing.pub"
  FAILED=1
fi

exit $FAILED
