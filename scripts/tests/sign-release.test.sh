#!/usr/bin/env bash
# Tests scripts/sign-release.sh (the signing step of the release workflow) with the
# development key of the fixtures: its output must pass the installer's
# verify_release_files, and it must refuse an empty key and the development public key.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
check() { if ! eval "$2"; then echo "FAIL $1"; FAILED=1; else echo "ok   $1"; fi; }

info() { :; }
success() { :; }
warn() { echo "WARN $*"; }
die() { echo "DIE $*" >&2; exit 1; }
sed -n '/^# BEGIN release functions/,/^# END release functions/p' "$ROOT/scripts/install.sh" > "$TMP/func.sh"
# shellcheck disable=SC1091
source "$TMP/func.sh"

DEV_KEY="$(cat "$ROOT/scripts/tests/fixtures/dev-signing.key")"
# The installer embeds the production key; this test signs with the development key.
RELEASE_SIGNING_PUB="$(printf '%s\n' "$DEV_KEY" | openssl pkey -pubout)"
NAME="hsi-v1.67.0-linux-amd64.tar.gz"
mkdir -p "$TMP/rel"
echo archive > "$TMP/rel/$NAME"
# The script checks the key against scripts/release-signing.pub (the production key):
# run a copy in a scratch tree whose public key is the development one.
mkdir -p "$TMP/tree/scripts"
cp "$ROOT/scripts/sign-release.sh" "$ROOT/scripts/install.sh" "$TMP/tree/scripts/"
printf '%s\n' "$RELEASE_SIGNING_PUB" > "$TMP/tree/scripts/release-signing.pub"
SIGN="$TMP/tree/scripts/sign-release.sh"
unset GITHUB_ACTIONS

check "refuses an empty key" '! HSI_RELEASE_SIGNING_KEY= HSI_ALLOW_DEV_SIGNING_KEY=1 "$SIGN" "$TMP/rel" "$NAME" >/dev/null 2>&1'
check "refuses the development public key" '! HSI_RELEASE_SIGNING_KEY="$DEV_KEY" "$SIGN" "$TMP/rel" "$NAME" >/dev/null 2>&1'
check "refuses a key that does not match the public key" \
  '! HSI_RELEASE_SIGNING_KEY="$(openssl genpkey -algorithm ed25519)" HSI_ALLOW_DEV_SIGNING_KEY=1 "$SIGN" "$TMP/rel" "$NAME" >/dev/null 2>&1'
check "refuses the development key override in CI" \
  'rm -f "$TMP/rel/SHA256SUMS"; ! GITHUB_ACTIONS=true HSI_RELEASE_SIGNING_KEY="$DEV_KEY" HSI_ALLOW_DEV_SIGNING_KEY=1 "$SIGN" "$TMP/rel" "$NAME" >/dev/null 2>&1 && [[ ! -e "$TMP/rel/SHA256SUMS" ]]'
check "signs with the matching key" 'HSI_RELEASE_SIGNING_KEY="$DEV_KEY" HSI_ALLOW_DEV_SIGNING_KEY=1 "$SIGN" "$TMP/rel" "$NAME" >/dev/null'
check "produces the four release files" '[[ -f "$TMP/rel/install.sh" && -s "$TMP/rel/SHA256SUMS" && -s "$TMP/rel/SHA256SUMS.sig" ]]'
check "SHA256SUMS lists exactly the archive and install.sh" \
  '[[ "$(cut -d" " -f3 "$TMP/rel/SHA256SUMS" | sort | tr "\n" " ")" == "$NAME install.sh " ]] && grep -Eq "^[0-9a-f]{64}  " "$TMP/rel/SHA256SUMS"'
check "the signature is a single base64 line" '[[ "$(wc -l < "$TMP/rel/SHA256SUMS.sig")" == 0 ]]'
export HSI_ALLOW_DEV_SIGNING_KEY=1
check "the installer accepts the output" '(verify_release_files "$TMP/rel" "$NAME") >/dev/null 2>&1'
echo tampered >> "$TMP/rel/SHA256SUMS"
check "the installer rejects a modified SHA256SUMS" '! (verify_release_files "$TMP/rel" "$NAME") >/dev/null 2>&1'

exit "$FAILED"
