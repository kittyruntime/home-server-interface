#!/usr/bin/env bash
# Tests the release verification of scripts/install.sh (verify_release_files,
# stage_release) without network or root: releases are served from a temp dir
# through file:// URLs and signed with the development key of the fixtures.
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
if ! grep -q '^verify_release_files()' "$TMP/func.sh" || ! grep -q '^stage_release()' "$TMP/func.sh"; then
  echo "FAIL verify_release_files or stage_release not found in scripts/install.sh"
  exit 1
fi
# shellcheck disable=SC1091
source "$TMP/func.sh"

DEV_KEY="$ROOT/scripts/tests/fixtures/dev-signing.key"
VERSION=v1.67.0
RELEASE_APP_NAME=hsi
NAME="hsi-${VERSION}-linux-amd64.tar.gz"

# make_release <dir> [key]: an archive, install.sh, SHA256SUMS and its signature.
make_release() {
  local dir=$1 key=${2:-$DEV_KEY}
  mkdir -p "$dir/src/hsi-$VERSION/bin"
  echo 'console.log("hsi")' > "$dir/src/hsi-$VERSION/server.js"
  printf '#!/bin/sh\necho worker\n' > "$dir/src/hsi-$VERSION/bin/hsi-worker"
  chmod +x "$dir/src/hsi-$VERSION/bin/hsi-worker"
  tar -czf "$dir/$NAME" -C "$dir/src" "hsi-$VERSION"
  rm -rf "$dir/src"
  printf '#!/bin/bash\necho install\n' > "$dir/install.sh"
  (cd "$dir" && sha256sum "$NAME" install.sh > SHA256SUMS)
  sign "$dir" "$key"
}
sign() { openssl pkeyutl -sign -inkey "$2" -rawin -in "$1/SHA256SUMS" | base64 -w0 > "$1/SHA256SUMS.sig"; }

# fresh <name>: a release served at file://$TMP/<name>/<version>/ and an empty DL_DIR.
fresh() {
  RELEASE_BASE_URL="file://$TMP/$1"
  SERVED="$TMP/$1/$VERSION"
  mkdir -p "$SERVED"
  make_release "$SERVED" "${2:-$DEV_KEY}"
  DL_DIR="$TMP/$1-dl"
  rm -rf "$DL_DIR"; mkdir -p "$DL_DIR"
}

export HSI_ALLOW_DEV_SIGNING_KEY=1
ALLOW_UNSIGNED=0
unset HSI_RELEASE_ARCHIVE

# 1. A signed release verifies.
fresh good
cp "$SERVED"/* "$DL_DIR/"
out="$(verify_release_files "$DL_DIR" "$NAME" 2>&1)"; rc=$?
check "signed release verifies" '[[ $rc -eq 0 ]]'

# 2. The development key is refused unless HSI_ALLOW_DEV_SIGNING_KEY=1.
out="$(HSI_ALLOW_DEV_SIGNING_KEY=0 verify_release_files "$DL_DIR" "$NAME" 2>&1)"; rc=$?
check "development key refused by default" '[[ $rc -ne 0 && "$out" == *"development key"* ]]'

# 3. Tampered archive.
fresh tampered-archive
echo extra >> "$SERVED/$NAME"
out="$( (stage_release) 2>&1)"; rc=$?
check "tampered archive refused" '[[ $rc -ne 0 && "$out" == *"do not match SHA256SUMS"* ]]'
check "tampered archive extracts nothing" '[[ ! -e "$DL_DIR/release" ]]'

# 4. Tampered SHA256SUMS (signature no longer matches).
fresh tampered-sums
(cd "$SERVED" && echo extra >> "$NAME" && sha256sum "$NAME" install.sh > SHA256SUMS)
out="$( (stage_release) 2>&1)"; rc=$?
check "tampered SHA256SUMS refused" '[[ $rc -ne 0 && "$out" == *"signature"* ]]'
check "tampered SHA256SUMS extracts nothing" '[[ ! -e "$DL_DIR/release" ]]'

# 5. Signed by another key.
openssl genpkey -algorithm ed25519 -out "$TMP/other.key" 2>/dev/null
fresh wrong-key "$TMP/other.key"
out="$( (stage_release) 2>&1)"; rc=$?
check "signature by another key refused" '[[ $rc -ne 0 && "$out" == *"signature"* ]]'
check "wrong key extracts nothing" '[[ ! -e "$DL_DIR/release" ]]'

# 6. A malformed SHA256SUMS line is refused even when signed.
fresh malformed
printf 'not a sum line\n' >> "$SERVED/SHA256SUMS"
sign "$SERVED" "$DEV_KEY"
out="$( (stage_release) 2>&1)"; rc=$?
check "malformed SHA256SUMS refused" '[[ $rc -ne 0 && "$out" == *"malformed"* ]]'

# 7. A signed release is staged: downloaded, verified and extracted.
fresh staged
( stage_release ) > "$TMP/staged.out" 2>&1; rc=$?
check "signed release is staged" '[[ $rc -eq 0 && -f "$DL_DIR/release/server.js" && -x "$DL_DIR/release/bin/hsi-worker" ]]'

# 8. No SHA256SUMS: refused, unless --allow-unsigned (with a warning).
fresh unsigned
rm "$SERVED/SHA256SUMS" "$SERVED/SHA256SUMS.sig"
out="$( (stage_release) 2>&1)"; rc=$?
check "unsigned release refused" '[[ $rc -ne 0 && "$out" == *"--allow-unsigned"* ]]'
check "unsigned release extracts nothing" '[[ ! -e "$DL_DIR/release" ]]'
out="$( (ALLOW_UNSIGNED=1; stage_release) 2>&1)"; rc=$?
check "unsigned release allowed with --allow-unsigned" '[[ $rc -eq 0 && "$out" == *"WARN"* && -f "$DL_DIR/release/server.js" ]]'

# 9. --allow-unsigned never skips a signature that exists.
fresh signed-allow "$TMP/other.key"
out="$( (ALLOW_UNSIGNED=1; stage_release) 2>&1)"; rc=$?
check "--allow-unsigned still checks an existing signature" '[[ $rc -ne 0 && ! -e "$DL_DIR/release" ]]'

# 10. OpenSSL older than 3 is refused with a clear message.
fresh old-openssl
cp "$SERVED"/* "$DL_DIR/"
out="$( (openssl() { if [[ "$1" == version ]]; then echo "OpenSSL 1.1.1w  11 Sep 2023"; else command openssl "$@"; fi; }
         verify_release_files "$DL_DIR" "$NAME") 2>&1)"; rc=$?
check "OpenSSL 1.1 refused" '[[ $rc -ne 0 && "$out" == *"OpenSSL 3"* ]]'

# 11. HSI_RELEASE_ARCHIVE (already verified by the worker) skips the download.
fresh local-archive
mv "$SERVED/$NAME" "$TMP/verified.tar.gz"
out="$( (HSI_RELEASE_ARCHIVE="$TMP/verified.tar.gz"; RELEASE_BASE_URL="file://$TMP/nowhere"; stage_release) 2>&1)"; rc=$?
check "HSI_RELEASE_ARCHIVE is used without downloading" '[[ $rc -eq 0 && -f "$DL_DIR/release/server.js" ]]'

# 12. An archive with an entry outside its root is refused before extraction.
fresh unsafe
mkdir -p "$TMP/evil/hsi-$VERSION" "$TMP/evil/other"
echo x > "$TMP/evil/hsi-$VERSION/server.js"; echo x > "$TMP/evil/other/file"
tar -czf "$SERVED/$NAME" -C "$TMP/evil" "hsi-$VERSION" other
(cd "$SERVED" && sha256sum "$NAME" install.sh > SHA256SUMS)
sign "$SERVED" "$DEV_KEY"
out="$( (stage_release) 2>&1)"; rc=$?
check "archive with an unexpected layout refused" '[[ $rc -ne 0 && "$out" == *"unsafe"* && ! -e "$DL_DIR/release" ]]'

exit $FAILED
