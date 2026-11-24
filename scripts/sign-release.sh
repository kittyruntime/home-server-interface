#!/usr/bin/env bash
# Usage: scripts/sign-release.sh <dir> <archive-name>...
#
# Release signing, run by the release workflow. <dir> holds the archives (one
# per architecture); this copies scripts/install.sh next to them, writes
# SHA256SUMS (the archives and install.sh) and SHA256SUMS.sig (base64 of the
# raw ed25519 signature), then verifies the signature against
# scripts/release-signing.pub. Installers and workers check only the lines of
# their own archive and install.sh, so one file serves every architecture.
#
# The private key (PEM PKCS#8) comes from HSI_RELEASE_SIGNING_KEY. Refuses to
# sign while scripts/release-signing.pub is still the development key (its
# private half is in the repository), unless HSI_ALLOW_DEV_SIGNING_KEY=1
# (tests only: refused when GITHUB_ACTIONS=true). The development key fingerprint is
# also in scripts/install.sh and release_verify.go; a test keeps the three equal.
set -euo pipefail

DEV_KEY_FINGERPRINT="0c9fde95a7afa23901ce53c94613f8f7a710af273942f2e7ff9aa86941cd4e7a"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-}"
shift || true
ARCHIVES=("$@")
if [[ -z "$DIR" || ${#ARCHIVES[@]} -eq 0 ]]; then
  echo "Usage: $0 <dir> <archive-name>..." >&2
  exit 1
fi
if [[ "${HSI_ALLOW_DEV_SIGNING_KEY:-}" == "1" && "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "HSI_ALLOW_DEV_SIGNING_KEY is for tests only and is refused in CI." >&2
  exit 1
fi
if [[ -z "${HSI_RELEASE_SIGNING_KEY:-}" ]]; then
  echo "HSI_RELEASE_SIGNING_KEY is empty: set the repository secret (see scripts/release.sh)." >&2
  exit 1
fi
for ARCHIVE in "${ARCHIVES[@]}"; do
  [[ -f "$DIR/$ARCHIVE" ]] || { echo "Archive not found: $DIR/$ARCHIVE" >&2; exit 1; }
done

PUB="$ROOT/scripts/release-signing.pub"
FP=$(openssl pkey -pubin -in "$PUB" -outform DER | tail -c 32 | sha256sum | cut -d' ' -f1)
if [[ "$FP" == "$DEV_KEY_FINGERPRINT" && "${HSI_ALLOW_DEV_SIGNING_KEY:-}" != "1" ]]; then
  echo "scripts/release-signing.pub is still the development key: refusing to publish a release it could not protect." >&2
  exit 1
fi

KEY_FILE=$(umask 077 && mktemp)
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s\n' "$HSI_RELEASE_SIGNING_KEY" > "$KEY_FILE"

cp "$ROOT/scripts/install.sh" "$DIR/install.sh"
(cd "$DIR" && sha256sum "${ARCHIVES[@]}" install.sh > SHA256SUMS)
openssl pkeyutl -sign -inkey "$KEY_FILE" -rawin -in "$DIR/SHA256SUMS" | base64 -w0 > "$DIR/SHA256SUMS.sig"

base64 -d < "$DIR/SHA256SUMS.sig" > "$DIR/SHA256SUMS.sig.bin"
if ! openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$DIR/SHA256SUMS" -sigfile "$DIR/SHA256SUMS.sig.bin" >/dev/null; then
  echo "The signature does not verify against scripts/release-signing.pub: wrong private key?" >&2
  exit 1
fi
rm -f "$DIR/SHA256SUMS.sig.bin"
echo "Signed ${ARCHIVES[*]} and install.sh (SHA256SUMS, SHA256SUMS.sig)."
