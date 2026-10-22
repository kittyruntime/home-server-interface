#!/usr/bin/env bash
# =============================================================================
# Build & Install Script
# =============================================================================
# Two modes:
#
#   Release (default): downloads a pre-built tarball from GitHub:
#     sudo bash install.sh
#     curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/install.sh | sudo bash
#
#   Source: builds and installs from the local repository:
#     sudo ./scripts/install.sh --from-source [BACKEND_USER]
#
# Re-run at any time to update; existing data and secrets are preserved.
#
# Release mode (safe updates, #9a): the archive is installed only once
# SHA256SUMS.sig (ed25519, key embedded below) and SHA256SUMS check out. Each
# version lives in INSTALL_DIR/releases/<version>/ and INSTALL_DIR/current links
# the active one; data and secrets stay at fixed paths (.env, database/data,
# data, /etc/APP_NAME, /var/lib/APP_NAME). An update snapshots the database and
# configuration, switches current, then waits until the new version is healthy;
# otherwise it rolls back to the previous version and database by itself.
# Source mode keeps its layout and skips signatures, releases and the health gate.
#
# Environment overrides (both modes):
#   APP_NAME              App identifier             (default: hsi)
#   BACKEND_PORT          API port                   (default: 9001)
#   NATS_SERVER_VERSION   NATS binary version        (default: v2.10.24)
#   SKIP_NGINX            Set to 1 to skip nginx     (default: 0)
#   SKIP_SEED             Set to 1 to skip DB seed   (default: 0)
#   HSI_LOG_LEVEL         Root worker log level: debug, info, warn, error
#                         (default: info, or the value already in worker.env)
#   SKIP_DEPS_INSTALL     Set to 1 to only check host packages, never
#                         install them with apt-get     (default: 0)
#
# Release-mode overrides:
#   VERSION               Release tag to install     (default: latest)
#   INSTALL_DIR           Installation directory     (default: /opt/APP_NAME)
#   APP_USER              System user to run as      (default: APP_NAME)
#   HSI_ALLOW_UNSIGNED    Set to 1 (or pass --allow-unsigned) to install a
#                         release published before signing (no SHA256SUMS)
#   HSI_RELEASE_BASE_URL  Where releases are downloaded from (tests, VM)
#   HSI_RELEASE_ARCHIVE   Archive already verified by `hsi-worker update apply`
# =============================================================================

set -euo pipefail

APP_NAME="${APP_NAME:-hsi}"
REPO="kittyruntime/home-server-interface"
RELEASE_APP_NAME="hsi"
RELEASE_BASE_URL="${HSI_RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download}"

# ── Mode detection ─────────────────────────────────────────────────────────────
FROM_SOURCE=0
ALLOW_UNSIGNED="${HSI_ALLOW_UNSIGNED:-0}"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]}"

# ── Common environment ─────────────────────────────────────────────────────────
BACKEND_PORT="${BACKEND_PORT:-9001}"
NATS_SERVER_VERSION="${NATS_SERVER_VERSION:-v2.10.24}"
SKIP_NGINX="${SKIP_NGINX:-0}"
SKIP_SEED="${SKIP_SEED:-0}"
SKIP_DEPS_INSTALL="${SKIP_DEPS_INSTALL:-0}"

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "  ${CYAN}··${NC}  $*"; }
success() { echo -e "  ${GREEN}✓${NC}   $*"; }
warn()    { echo -e "  ${YELLOW}!${NC}   $*"; }
die()     { echo -e "\n  ${RED}✗ error:${NC} $*\n" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▶ $*${NC}"; }

# install_restic: the backup engine (#15), from the official restic release at
# a pinned version, checked against a pinned SHA-256. A failure is reported and
# leaves versioned backups unavailable; the rest of HSI installs normally.
RESTIC_VERSION="0.19.1"
RESTIC_SHA256_amd64="f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c"
RESTIC_SHA256_arm64="a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465"
RESTIC_DEST="${RESTIC_DEST:-/usr/local/lib/hsi/restic}"
RESTIC_URL_BASE="${RESTIC_URL_BASE:-https://github.com/restic/restic/releases/download}"

install_restic() {
  local arch sum tmp
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) warn "No restic build for $(uname -m): versioned backups are unavailable"; return 1 ;;
  esac
  if [[ -x "$RESTIC_DEST" ]] && "$RESTIC_DEST" version 2>/dev/null | grep -q "restic ${RESTIC_VERSION} "; then
    return 0
  fi
  sum="RESTIC_SHA256_${arch}"; sum="${!sum}"
  tmp="$(mktemp -d)"
  if ! curl -fsSL --retry 3 -o "$tmp/restic.bz2" "${RESTIC_URL_BASE}/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${arch}.bz2"; then
    rm -rf "$tmp"; warn "Could not download restic ${RESTIC_VERSION}: versioned backups are unavailable until the installer runs again"; return 1
  fi
  if [[ "$(sha256sum "$tmp/restic.bz2" | cut -d' ' -f1)" != "$sum" ]]; then
    rm -rf "$tmp"; warn "restic ${RESTIC_VERSION} download does not match its checksum: not installed"; return 1
  fi
  # Root-owned so the worker never runs a binary another user could replace.
  local owner=(); (( EUID == 0 )) && owner=(-o root -g root)
  if ! { bunzip2 -c "$tmp/restic.bz2" > "$tmp/restic" && install -D -m 0755 "${owner[@]}" "$tmp/restic" "$RESTIC_DEST"; }; then
    rm -rf "$tmp"; warn "Could not unpack or install restic ${RESTIC_VERSION}: versioned backups are unavailable"; return 1
  fi
  rm -rf "$tmp"
}

# Run a shell snippet as another user with that user's HOME. runuser ships with
# util-linux, so the installer does not depend on sudo being installed.
run_as() {
  local user=$1 home
  shift
  home=$(getent passwd "$user" | cut -d: -f6)
  runuser -u "$user" -- env HOME="${home:-/}" bash -c "$*"
}

# ── Safe updates (#9a): signed releases, side-by-side layout ───────────────────
# BEGIN release functions (sourced on their own by scripts/tests/install-*.test.sh)

# The public key that signs SHA256SUMS. Copies: scripts/release-signing.pub and
# apps/root-worker/release-signing.pub; a test keeps the three identical.
RELEASE_SIGNING_PUB=$(cat <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQMjBiANUezp60y5OYMMRTJvmiElfHzjGNfHqlecSWn0=
-----END PUBLIC KEY-----
PEM
)
# sha256 of the raw development public key. Its private half is committed with the
# tests, so it is trusted only with HSI_ALLOW_DEV_SIGNING_KEY=1 (tests, VM).
DEV_SIGNING_KEY_FINGERPRINT="0c9fde95a7afa23901ce53c94613f8f7a710af273942f2e7ff9aa86941cd4e7a"

# Code paths of a release. A flat install (before #9a) has them directly in
# INSTALL_DIR; they move to releases/<version>/ and are linked back (link_flat_paths).
RELEASE_CODE_PATHS=(
  server.js public bin node_modules runtime scripts
  database/prisma database/src database/package.json compose
  package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE CHANGELOG.md README.md
)
INSTALLED_VERSION_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

openssl_can_verify() {
  local major
  major=$(openssl version 2>/dev/null | sed -n 's/^OpenSSL \([0-9][0-9]*\)\..*/\1/p')
  [[ -n "$major" ]] && (( major >= 3 ))
}

# verify_release_files <dir> <archive-name>: <dir>/SHA256SUMS must be signed by the
# embedded key (SHA256SUMS.sig, base64 of the raw ed25519 signature), then
# check_release_sums.
verify_release_files() {
  local dir=$1 archive=$2 fp
  openssl_can_verify \
    || die "OpenSSL 3 or newer is needed to verify the release signature (found: $(openssl version 2>/dev/null || echo none)). Upgrade OpenSSL, or install a release by hand after checking it."
  printf '%s\n' "$RELEASE_SIGNING_PUB" > "$dir/release-signing.pub"
  fp=$(openssl pkey -pubin -in "$dir/release-signing.pub" -outform DER 2>/dev/null | tail -c 32 | sha256sum | cut -d' ' -f1)
  if [[ "$fp" == "$DEV_SIGNING_KEY_FINGERPRINT" && "${HSI_ALLOW_DEV_SIGNING_KEY:-}" != "1" ]]; then
    die "The release signing key of this installer is a development key: refusing to trust releases signed by it."
  fi
  [[ -f "$dir/SHA256SUMS" && -f "$dir/SHA256SUMS.sig" ]] || die "SHA256SUMS or SHA256SUMS.sig is missing."
  tr -d '\r\n' < "$dir/SHA256SUMS.sig" | base64 -d > "$dir/SHA256SUMS.sig.bin" 2>/dev/null \
    && [[ "$(stat -c %s "$dir/SHA256SUMS.sig.bin")" == 64 ]] \
    || die "SHA256SUMS.sig is not a base64 ed25519 signature."
  openssl pkeyutl -verify -pubin -inkey "$dir/release-signing.pub" -rawin \
      -in "$dir/SHA256SUMS" -sigfile "$dir/SHA256SUMS.sig.bin" >/dev/null 2>&1 \
    || die "The SHA256SUMS signature is invalid: this release is not authentic."
  check_release_sums "$dir" "$archive"
}

# check_release_sums <dir> <archive-name>: every line of <dir>/SHA256SUMS is
# "<sha256>  <name>", each name once; the archive, and install.sh when <dir> holds
# one, are listed and match.
check_release_sums() {
  local dir=$1 archive=$2 line name sums="" seen=" "
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[0-9a-fA-F]{64}\ \ ([^/[:space:]]+)$ ]] || die "SHA256SUMS has a malformed line."
    name=${BASH_REMATCH[1]}
    [[ "$seen" != *" $name "* ]] || die "$name is listed twice in SHA256SUMS."
    seen+="$name "
    if [[ "$name" == "$archive" || ( "$name" == install.sh && -f "$dir/install.sh" ) ]]; then
      sums+="$line"$'\n'
    fi
  done < "$dir/SHA256SUMS"
  [[ "$seen" == *" $archive "* ]] || die "$archive is not listed in SHA256SUMS."
  if [[ -f "$dir/install.sh" && "$seen" != *" install.sh "* ]]; then
    die "install.sh is not listed in SHA256SUMS."
  fi
  printf '%s' "$sums" > "$dir/SHA256SUMS.checked"
  (cd "$dir" && sha256sum --strict --status -c SHA256SUMS.checked) \
    || die "The release files do not match SHA256SUMS: this release is not authentic."
}

# stage_release: puts the archive of $VERSION in $DL_DIR (downloaded from
# $RELEASE_BASE_URL and verified, or taken as is from HSI_RELEASE_ARCHIVE, which
# `hsi-worker update apply` has verified already), checks its layout, then extracts
# it to $DL_DIR/release. A refusal leaves nothing extracted.
stage_release() {
  local name="${RELEASE_APP_NAME}-${VERSION}-linux-amd64.tar.gz"
  local url="${RELEASE_BASE_URL}/${VERSION}" root="${RELEASE_APP_NAME}-${VERSION}"
  TARBALL="$DL_DIR/$name"
  RELEASE_STAGE="$DL_DIR/release"
  if [[ -n "${HSI_RELEASE_ARCHIVE:-}" ]]; then
    [[ -f "$HSI_RELEASE_ARCHIVE" ]] || die "HSI_RELEASE_ARCHIVE is not a file: $HSI_RELEASE_ARCHIVE"
    cp -- "$HSI_RELEASE_ARCHIVE" "$TARBALL"
    info "Using the archive verified by the worker"
  elif curl -fsSL "$url/SHA256SUMS" -o "$DL_DIR/SHA256SUMS" 2>/dev/null; then
    curl -fsSL "$url/SHA256SUMS.sig" -o "$DL_DIR/SHA256SUMS.sig" \
      || die "The release $VERSION has a SHA256SUMS but no SHA256SUMS.sig: refusing it."
    curl -fsSL --progress-bar "$url/$name" -o "$TARBALL" || die "Download failed: $url/$name"
    if ! openssl_can_verify && [[ "$ALLOW_UNSIGNED" == "1" ]]; then
      warn "OpenSSL 3 is missing: installing $VERSION WITHOUT checking its signature (--allow-unsigned)."
      check_release_sums "$DL_DIR" "$name"
    else
      verify_release_files "$DL_DIR" "$name"
      success "Signature and checksum verified"
    fi
  elif [[ "$ALLOW_UNSIGNED" == "1" ]]; then
    warn "The release $VERSION is not signed (no SHA256SUMS): installing it unverified (--allow-unsigned)."
    curl -fsSL --progress-bar "$url/$name" -o "$TARBALL" || die "Download failed: $url/$name"
  else
    die "The release $VERSION has no SHA256SUMS (or it could not be downloaded), so it cannot be verified. A release published before signing installs with --allow-unsigned (or HSI_ALLOW_UNSIGNED=1)."
  fi
  tar -tzf "$TARBALL" | while IFS= read -r entry; do
    [[ "$entry" == "$root" || "$entry" == "$root/"* ]] || exit 1
    rel="${entry#"$root"}"
    rel="${rel#/}"
    [[ "$rel" != ".." && "$rel" != ../* && "$rel" != */../* && "$rel" != */.. ]] || exit 1
  done || die "Release archive has an unsafe or unexpected layout."
  mkdir -p "$RELEASE_STAGE"
  tar -xzf "$TARBALL" --no-same-owner --strip-components=1 -C "$RELEASE_STAGE" \
    || { rm -rf -- "$RELEASE_STAGE"; die "Could not extract the release archive."; }
}

# root_owned <path>...: recursively root-owned, not writable by group or others and
# without setuid or setgid bits, so the app user cannot change code the worker runs
# as root. Links are never followed. Skipped when not root (tests).
root_owned() {
  (( EUID == 0 )) || return 0
  chown -hR root:root "$@" && chmod -R go-w,ug-s "$@"
}

# check_data_paths: the data the app user owns must be real files and folders.
# Root changes their owner and mode and writes .env: through a link planted by the
# app user it would change any file of the system.
check_data_paths() {
  local p paths=("$DB_DIR" "$DB_FILE" "$DB_FILE-wal" "$ENV_FILE")
  [[ "$FROM_SOURCE" -eq 1 ]] || paths+=("$APP_DIR/data" "$APP_DIR/database")
  for p in "${paths[@]}"; do
    [[ ! -L "$p" ]] || die "$p is a symbolic link: the installer refuses to work through it. Replace it with the real file or folder, then re-run."
  done
}

# is_flat_install: code directly in INSTALL_DIR (before #9a), or a conversion that
# was interrupted before current was linked.
is_flat_install() {
  [[ ! -L "$INSTALL_DIR/current" ]] \
    && { [[ -f "$INSTALL_DIR/server.js" && ! -L "$INSTALL_DIR/server.js" ]] || [[ -d "$INSTALL_DIR/releases" ]]; }
}

# flat_version: the VERSION of a flat install; after an interrupted conversion moved
# it, the only release present; else v0.0.0-flat.
flat_version() {
  local v="" found
  if [[ -f "$INSTALL_DIR/VERSION" && ! -L "$INSTALL_DIR/VERSION" ]]; then
    v=$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")
  else
    found=("$INSTALL_DIR"/releases/v*/)
    (( ${#found[@]} == 1 )) && [[ -d "${found[0]}" ]] && v=$(basename "${found[0]}")
  fi
  [[ "$v" =~ $INSTALLED_VERSION_RE ]] || v="v0.0.0-flat"
  echo "$v"
}

# convert_flat_install: moves the code paths of a flat install, VERSION last, into
# releases/<its version>/ and points current at it, so the version updated from is a
# rollback target. .env, database/data and data never move. Every move is a rename:
# an interrupted conversion resumes. The release keeps the worker that ran as root
# (/usr/local/bin), not the app-owned copy in bin/. Sets OLD_VERSION.
convert_flat_install() {
  local old rel dest
  old=$(flat_version)
  dest="$INSTALL_DIR/releases/$old"
  mkdir -p "$dest/database" || return 1
  for rel in "${RELEASE_CODE_PATHS[@]}" VERSION; do
    [[ -e "$INSTALL_DIR/$rel" && ! -L "$INSTALL_DIR/$rel" ]] || continue
    mkdir -p "$dest/$(dirname "$rel")" && mv -T -- "$INSTALL_DIR/$rel" "$dest/$rel" || return 1
  done
  if [[ -f "$SYSTEM_WORKER" && ! -L "$SYSTEM_WORKER" ]]; then
    mkdir -p "$dest/bin" && cp -- "$SYSTEM_WORKER" "$dest/bin/${RELEASE_APP_NAME}-worker.tmp" \
      && chmod 755 "$dest/bin/${RELEASE_APP_NAME}-worker.tmp" \
      && mv -T -- "$dest/bin/${RELEASE_APP_NAME}-worker.tmp" "$dest/bin/${RELEASE_APP_NAME}-worker" || return 1
  fi
  ln -sfn "$DB_DIR" "$dest/database/data" || return 1
  root_owned "$dest" || return 1
  ln -sfn "$dest" "$INSTALL_DIR/current.tmp" && mv -T -- "$INSTALL_DIR/current.tmp" "$INSTALL_DIR/current" || return 1
  OLD_VERSION=$old
}

# link_flat_paths: each code path, and VERSION, at the top of INSTALL_DIR becomes a
# link through current. A version before #9a that a rollback brings back runs from
# its restored unit files, which name these flat paths, and reads INSTALL_DIR/VERSION;
# the backend of every version reads that VERSION too.
link_flat_paths() {
  local rel
  for rel in "${RELEASE_CODE_PATHS[@]}" VERSION; do
    [[ -e "$INSTALL_DIR/$rel" && ! -L "$INSTALL_DIR/$rel" ]] && continue
    mkdir -p "$INSTALL_DIR/$(dirname "$rel")" && ln -sfn "$INSTALL_DIR/current/$rel" "$INSTALL_DIR/$rel" || return 1
  done
}

# install_release_dir [prepare]: copies the validated stage to releases/.staging-$$,
# with VERSION, database/data linked to the live database directory and the
# @app/compose link of the data migrations, all root's. [prepare] then runs with the
# staging dir (the Prisma client: node_modules is the app user's meanwhile, nothing
# root runs lives there) before node_modules is root's again and the release is
# renamed to releases/$VERSION, replacing a leftover of that version. current is not
# touched.
install_release_dir() {
  local releases="$INSTALL_DIR/releases" tmp prepare=${1:-}
  tmp="$releases/.staging-$$"
  mkdir -p "$releases" && rm -rf -- "$releases"/.staging-* && mkdir "$tmp" || return 1
  if ! { cp -a "$RELEASE_STAGE/." "$tmp/" \
         && mkdir -p "$tmp/database" "$tmp/node_modules/@app" \
         && rm -rf -- "$tmp/database/data" && ln -s "$DB_DIR" "$tmp/database/data" \
         && ln -sfn ../../compose "$tmp/node_modules/@app/compose" \
         && echo "$VERSION" > "$tmp/VERSION" \
         && root_owned "$tmp"; }; then
    rm -rf -- "$tmp"; return 1
  fi
  if [[ -n "$prepare" ]]; then
    if (( EUID == 0 )); then chown -hR "$APP_USER:" "$tmp/node_modules" || { rm -rf -- "$tmp"; return 1; }; fi
    "$prepare" "$tmp" && root_owned "$tmp/node_modules" || { rm -rf -- "$tmp"; return 1; }
  fi
  rm -rf -- "${releases:?}/$VERSION" && mv -T -- "$tmp" "$releases/$VERSION"
}

# worker_update <worker binary> <args>: `hsi-worker update <args>` with the paths of
# this install, so a custom APP_NAME or INSTALL_DIR is honoured before worker.env
# carries them.
worker_update() {
  local bin=$1
  shift
  env HSI_INSTALL_DIR="$INSTALL_DIR" HSI_UPDATE_STATE="$UPDATE_STATE" HSI_UPDATE_DB="$DB_FILE" \
    HSI_UNIT_PREFIX="$APP_NAME" HSI_WORKER_ENV="$WORKER_ENV" HSI_NATS_CONF="$NATS_CONF" \
    HSI_BACKEND_ENV="$ENV_FILE" HSI_BACKUP_CONFIG="$BACKUP_CONFIG" \
    "$bin" update "$@"
}

# END release functions

# ── Host packages ──────────────────────────────────────────────────────────────
# command:package. Required ones are installed with apt-get when missing (unless
# SKIP_DEPS_INSTALL=1); optional ones only enable a feature and are reported.
REQUIRED_DEPS=(
  curl:curl bunzip2:bzip2 openssl:openssl rsync:rsync ssh:openssh-client
  runuser:util-linux flock:util-linux lsblk:util-linux blkid:util-linux
  mdadm:mdadm smartctl:smartmontools pvcreate:lvm2
  parted:parted partprobe:parted mkfs.ext4:e2fsprogs udevadm:udev
)
OPTIONAL_DEPS=(
  "docker:docker.io:Apps and App Store"
  "smbd:samba:SMB sharing"
)

ensure_dependencies() {
  step "Checking host packages"
  local entry cmd pkg missing=()
  for entry in "${REQUIRED_DEPS[@]}"; do
    cmd=${entry%%:*}; pkg=${entry#*:}
    command -v "$cmd" &>/dev/null && continue
    [[ " ${missing[*]} " == *" $pkg "* ]] || missing+=("$pkg")
  done

  if (( ${#missing[@]} > 0 )); then
    warn "Missing required packages: ${missing[*]}"
    if [[ "$SKIP_DEPS_INSTALL" == "1" ]] || ! command -v apt-get &>/dev/null; then
      die "Install them first: apt-get install ${missing[*]}"
    fi
    info "Installing: apt-get install -y ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq \
      && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null \
      || die "Could not install ${missing[*]}. Install them manually: apt-get install ${missing[*]}"
    for entry in "${REQUIRED_DEPS[@]}"; do
      cmd=${entry%%:*}
      command -v "$cmd" &>/dev/null || die "'$cmd' is still missing after installing ${entry#*:}."
    done
  fi
  success "Required packages present"

  local rest feature
  for entry in "${OPTIONAL_DEPS[@]}"; do
    cmd=${entry%%:*}; rest=${entry#*:}; pkg=${rest%%:*}; feature=${rest#*:}
    command -v "$cmd" &>/dev/null || warn "Optional: install '$pkg' to enable $feature."
  done
}

DL_DIR=""
RELEASE_STAGE=""
DB_ROLLBACK_FILE=""
SERVICES_STOPPED=0
# Release-mode update state (#9a): the snapshot, the worker of the new release
# that records each step, and whether the update reached its end.
OLD_VERSION=""
SNAP=""
NEW_WORKER=""
UPDATE_MARKED=0
UPDATE_FINISHED=0
CURRENT_STEP=""

# Fixed paths the update snapshot and the worker share.
APP_CONF_DIR="/etc/${APP_NAME}"
NATS_CONF="$APP_CONF_DIR/nats.conf"
WORKER_ENV="$APP_CONF_DIR/worker.env"
BACKUP_CONFIG="$APP_CONF_DIR/backup.json"
UPDATE_STATE="/var/lib/${APP_NAME}/update"
SYSTEM_WORKER="/usr/local/bin/${APP_NAME}-worker"
# The first release whose worker has the `update` commands and the health gate
# (firstHealthVersion in apps/root-worker/update_health.go).
FIRST_SAFE_UPDATE_VERSION="v1.67.0"

# version_lt <a> <b>: a sorts before b (numeric X.Y.Z, suffix ignored).
version_lt() {
  local a=${1#v} b=${2#v}
  a=${a%%-*}; b=${b%%-*}
  [[ "$a" != "$b" && "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)" == "$a" ]]
}

# mark_update <step>: records the step in the in-progress marker. From the first
# mark on, any failure rolls the update back (cleanup_install_exit).
mark_update() {
  CURRENT_STEP=$1
  worker_update "$NEW_WORKER" mark "$OLD_VERSION" "$VERSION" "$SNAP" "$1" --pid $$ \
    || die "Could not record the update step '$1'."
  UPDATE_MARKED=1
}

# rollback_update <reason>: the worker of the new release restores the snapshot (the
# previous release, database and configuration), restarts and checks the previous
# version. The installer holds the update lock, and says so.
rollback_update() {
  UPDATE_FINISHED=1
  warn "Rolling back to $OLD_VERSION: $1"
  if HSI_UPDATE_LOCK_HELD=1 worker_update "$NEW_WORKER" rollback --snapshot "$SNAP" --yes --reason "$1"; then
    warn "Rolled back to $OLD_VERSION."
  else
    warn "The rollback failed: run 'sudo ${APP_NAME}-worker update rollback --snapshot $SNAP'."
  fi
}

# recover_interrupted_update: an installer killed midway left its marker. When the
# worker did not roll it back yet (a version before #9a is current, or it did not
# restart), it is rolled back before anything else.
recover_interrupted_update() {
  local to bin status
  to=$(sed -n 's/^ *"to": *"\([^"]*\)".*/\1/p' "$UPDATE_STATE/in-progress.json" | head -1)
  # The worker of the release updated to, else the one just verified: both have
  # the update commands, the version floor guarantees it.
  bin="$INSTALL_DIR/releases/$to/bin/${RELEASE_APP_NAME}-worker"
  [[ "$to" =~ $INSTALLED_VERSION_RE && -x "$bin" && ! -L "$INSTALL_DIR/releases/$to" ]] \
    || bin="$RELEASE_STAGE/bin/${RELEASE_APP_NAME}-worker"
  warn "An earlier update to $to was interrupted: rolling it back first."
  DB_FILE=$(sed -n 's/^HSI_UPDATE_DB=//p' "$WORKER_ENV" 2>/dev/null | head -1)
  DB_FILE=${DB_FILE:-$INSTALL_DIR/database/data/hsi.db}
  ENV_FILE="$INSTALL_DIR/.env"
  worker_update "$bin" recover || true
  status=$(sed -n 's/^ *"status": *"\([^"]*\)".*/\1/p' "$UPDATE_STATE/last.json" 2>/dev/null | head -1)
  [[ ! -f "$UPDATE_STATE/in-progress.json" && "$status" == "rolled-back" ]] \
    || die "The interrupted update could not be rolled back (see $UPDATE_STATE/last.json). Run 'sudo ${APP_NAME}-worker update rollback', then re-run."
  success "Interrupted update rolled back"
}

cleanup_install_exit() {
  local status=$?
  set +e
  if (( status != 0 )); then
    if (( UPDATE_MARKED == 1 && UPDATE_FINISHED == 0 )); then
      rollback_update "the installer failed during the '$CURRENT_STEP' step (exit $status)"
    else
      if [[ -n "$DB_ROLLBACK_FILE" && -f "$DB_ROLLBACK_FILE" && -n "${DB_FILE:-}" ]]; then
        warn "Restoring the pre-update database backup."
        run_as "$APP_USER" "cp -- '$DB_ROLLBACK_FILE' '$DB_FILE'"
      fi
      # Release mode before the snapshot: nothing to undo, the previous version
      # starts again if current still leads to it.
      if (( SERVICES_STOPPED == 1 )) && [[ "$FROM_SOURCE" -eq 0 && -L "${INSTALL_DIR:-}/current" && ! -f "${INSTALL_DIR:-}/current/server.js" ]]; then
        warn "Not restarting: $INSTALL_DIR/current does not lead to an installed release. Re-run the installer."
      elif (( SERVICES_STOPPED == 1 )); then
        warn "Restarting the previous services after the failed update."
        if [[ -f "/etc/systemd/system/${APP_NAME}.target" ]]; then
          systemctl start "${APP_NAME}.target" >/dev/null 2>&1 || true
        else
          systemctl start "${APP_NAME}-nats" "${APP_NAME}-root-worker" "${APP_NAME}" >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
  if [[ -n "$DL_DIR" && -d "$DL_DIR" ]]; then
    rm -rf -- "$DL_DIR"
  fi
}
trap cleanup_install_exit EXIT

[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]] \
  || die "APP_NAME must start with a lowercase letter and contain only lowercase letters, digits, or hyphens."
[[ "$BACKEND_PORT" =~ ^[0-9]{1,5}$ ]] \
  && (( 10#$BACKEND_PORT >= 1 && 10#$BACKEND_PORT <= 65535 )) \
  || die "BACKEND_PORT must be an integer between 1 and 65535."
[[ "$NATS_SERVER_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "NATS_SERVER_VERSION must be a tag such as v2.10.24."

# ── Must run as root ───────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root: sudo $0 (or from a root shell)"

# Also re-checked on every update: new releases may need new host tools.
ensure_dependencies

# One install or update at a time, the legacy migration included: the update lock
# is held until the installer exits. The worker's interrupted-update recovery and
# `update rollback` take it too.
mkdir -p "$(dirname "$UPDATE_STATE")"
install -d -m 0700 "$UPDATE_STATE"
exec 9>>"$UPDATE_STATE/update.lock"
flock -n 9 || die "Another update or rollback is running; wait for it to finish, then re-run."

# ── Legacy "app" install migration (app -> hsi rename) ────────────────────────
# Older installs used APP_NAME=app: units app*, /opt/app, user/group "app",
# /etc/app. When this run targets the default "hsi" and such an install is
# present, migrate it in place. Forward-only and idempotent: every step checks
# real on-disk state, so a crashed migration resumes on the next run. Legacy
# unit FILES are only removed in cleanup_legacy_app_units, after the new hsi*
# units are enabled, so the box is never left without unit files.
LEGACY_MIGRATED=0
LEGACY_UNITS=(app.service app-nats.service app-root-worker.service
  app-update-check.service app-update-check.timer
  app-update-apply.service app-update-apply.path)
MIGRATE_LOG="/var/log/hsi/migrate-app-to-hsi.log"

mlog() { echo "[$(date '+%F %T')] $*" >> "$MIGRATE_LOG"; }

detect_legacy_app_install() {
  [[ "$APP_NAME" == "hsi" ]] || return 1
  [[ -f /etc/systemd/system/app.service || -d /opt/app ]] || return 1
  if [[ -e /opt/hsi && ! -d /opt/hsi ]]; then
    die "/opt/hsi exists but is not a directory - resolve manually, then re-run."
  fi
  if [[ -d /opt/app && -d /opt/hsi && -n "$(ls -A /opt/hsi 2>/dev/null)" ]]; then
    die "Both /opt/app and a non-empty /opt/hsi exist - resolve manually, then re-run."
  fi
  if id app &>/dev/null && id hsi &>/dev/null; then
    die "Both 'app' and 'hsi' users exist - resolve manually, then re-run."
  fi
  if id app &>/dev/null && ! id hsi &>/dev/null && getent group hsi >/dev/null 2>&1; then
    die "Group 'hsi' already exists but user 'app' is not yet renamed - resolve manually, then re-run."
  fi
  return 0
}

# hsi.service -> hsi-server.service, hsi-root-worker.service -> hsi-worker.service,
# boot through hsi.target (#21). Idempotent: a rerun after an interruption
# finishes the job. Only unit files and the worker binary change.
migrate_service_names() {
  local unit changed=0
  for unit in "${APP_NAME}.service" "${APP_NAME}-root-worker.service"; do
    if [[ -L "/etc/systemd/system/$unit" ]]; then
      # Alias left for a release older than #21 (see below): not a unit.
      rm -f "/etc/systemd/system/$unit"
      changed=1
    elif [[ -e "/etc/systemd/system/$unit" ]]; then
      systemctl stop "$unit" 2>/dev/null || true
      systemctl disable "$unit" 2>/dev/null || true
      rm -f "/etc/systemd/system/$unit"
      info "Removed legacy unit $unit"
      changed=1
    fi
  done
  if [[ -e "/usr/local/bin/${APP_NAME}-root-worker" && -x "/usr/local/bin/${APP_NAME}-worker" ]]; then
    rm -f "/usr/local/bin/${APP_NAME}-root-worker"
    info "Removed legacy binary /usr/local/bin/${APP_NAME}-root-worker"
  fi
  if (( changed )); then systemctl daemon-reload; fi
  # The target starts NATS now; a direct multi-user.target link would be a
  # second boot path.
  if systemctl is-enabled "${APP_NAME}-nats" 2>/dev/null | grep -qx enabled; then
    systemctl disable "${APP_NAME}-nats" 2>/dev/null || true
  fi
}

migrate_legacy_app_install() {
  step "Migrating legacy 'app' install to 'hsi'"
  mkdir -p /var/log/hsi
  mlog "migration started (pid $$)"

  # 1. Stop legacy services. NEVER app-update-apply.service: during an
  #    auto-update it is the unit running this very script.
  for unit in app app-root-worker app-nats app-update-check.timer; do
    systemctl stop "$unit" 2>/dev/null || true
  done
  mlog "legacy services stopped"

  # 2. Disable all legacy units (files stay until cleanup_legacy_app_units).
  systemctl disable "${LEGACY_UNITS[@]}" 2>/dev/null || true
  mlog "legacy units disabled"

  if id app &>/dev/null; then
    # 3. usermod -l fails while processes run as the old user - wait for idle.
    for _ in $(seq 1 30); do
      pgrep -u app >/dev/null 2>&1 || break
      sleep 0.5
    done
    if pgrep -u app >/dev/null 2>&1; then
      ps -u app -o pid,cmd >&2
      die "Processes still running as user 'app' (listed above) - stop them and re-run."
    fi

    if id hsi &>/dev/null; then
      die "Both 'app' and 'hsi' users exist - resolve manually, then re-run."
    fi

    # 4. Rename user in place. uid is preserved, so file ownership everywhere
    #    on disk follows without a single chown.
    usermod -l hsi app
    mlog "user app renamed to hsi"
  fi
  if getent group app >/dev/null 2>&1; then
    groupmod -n hsi app
    mlog "group app renamed to hsi"
  fi
  if id hsi &>/dev/null; then
    usermod -d /opt/hsi hsi
  fi

  # 5. Move the install dir. rmdir first: mv into an existing dir would nest
  #    /opt/app INSIDE /opt/hsi. detect_legacy_app_install already guaranteed
  #    a non-empty /opt/hsi cannot reach this point.
  if [[ -d /opt/app ]]; then
    [[ -d /opt/hsi ]] && rmdir /opt/hsi
    mv /opt/app /opt/hsi
    mlog "/opt/app moved to /opt/hsi"

    # A queued update marker must not survive the move: the new
    # hsi-update-apply.path fires the instant it is enabled if the file
    # exists, launching a second concurrent install. Both the pre- and
    # post-move marker locations are cleared since older installs wrote it
    # at the install root before that path became unwritable by the app user.
    rm -f /opt/hsi/.pending-update /opt/hsi/database/data/.pending-update
    mlog "stale .pending-update removed"
  fi

  # 6. Move the config dir and rewrite absolute paths inside it.
  if [[ -d /etc/app ]]; then
    if [[ -d /etc/hsi ]]; then
      rmdir /etc/hsi 2>/dev/null \
        || die "Both /etc/app and a non-empty /etc/hsi exist - resolve manually, then re-run."
    fi
    mv /etc/app /etc/hsi
    for f in /etc/hsi/nats.conf /etc/hsi/worker.env; do
      [[ -f "$f" ]] && sed -i 's|/opt/app|/opt/hsi|g; s|/etc/app|/etc/hsi|g' "$f"
    done
    mlog "/etc/app moved to /etc/hsi (absolute paths rewritten)"
  fi

  LEGACY_MIGRATED=1
  success "Legacy install migrated (log: $MIGRATE_LOG)"
}

cleanup_legacy_app_units() {
  [[ "$LEGACY_MIGRATED" -eq 1 ]] || return 0
  step "Removing legacy 'app' unit files"
  for unit in "${LEGACY_UNITS[@]}"; do
    rm -f "/etc/systemd/system/$unit"
  done
  rm -f /usr/local/bin/app-check-update
  rm -f /usr/local/bin/app-root-worker
  rm -f /etc/logrotate.d/app
  rm -rf /var/lib/app
  systemctl stop app-update-apply.path app-update-check.timer 2>/dev/null || true
  systemctl daemon-reload
  systemctl reset-failed 'app*' 2>/dev/null || true

  if [[ -e /etc/nginx/sites-enabled/app || -e /etc/nginx/sites-available/app ]]; then
    rm -f /etc/nginx/sites-enabled/app /etc/nginx/sites-available/app
    nginx -t 2>/dev/null && systemctl reload nginx || true
    mlog "legacy nginx site removed"
  fi

  mlog "legacy unit files removed - migration complete"
  success "Legacy 'app' units removed (migrated install now fully 'hsi')"
}

# Migrate a legacy "app"-named install FIRST - before either mode branch can
# create the hsi user (release mode's useradd) or resolve paths, and before
# fresh/update detection reads the DB under the new /opt/hsi location.
if detect_legacy_app_install; then
  if [[ "$FROM_SOURCE" -eq 0 ]]; then
    # Never start mutating the box for a release asset that does not exist
    # (e.g. a pre-rename VERSION pin): resolve + normalize the version and
    # HEAD-check the tarball now. Failing here changes NOTHING on disk.
    if [[ -z "${VERSION:-}" ]]; then
      VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -oP '"tag_name":\s*"\K[^"]+')
      [[ -n "$VERSION" ]] || die "Could not fetch latest release from GitHub."
    fi
    VERSION="v${VERSION#v}"
    ! version_lt "$VERSION" "$FIRST_SAFE_UPDATE_VERSION" \
      || die "This installer installs $FIRST_SAFE_UPDATE_VERSION or newer; $VERSION installs with its own installer - nothing was changed."
    PRE_URL="${RELEASE_BASE_URL}/${VERSION}/${RELEASE_APP_NAME}-${VERSION}-linux-amd64.tar.gz"
    curl -fsIL --max-time 30 "$PRE_URL" >/dev/null \
      || die "Release asset not found for ${VERSION} (pre-rename version pin?) - nothing was changed. Re-run without VERSION to use the latest release."
  fi
  migrate_legacy_app_install
fi

echo -e "${BOLD}"
echo "  Install / Update: $(date '+%Y-%m-%d %H:%M')"
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  echo "  Mode: build from source"
else
  echo "  Mode: install from release"
fi
echo -e "${NC}"

# =============================================================================
# SOURCE MODE: resolve paths, check tools, build everything
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then

  BACKEND_USER="${1:-${SUDO_USER:-$(logname 2>/dev/null || whoami)}}"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  APP_USER="$BACKEND_USER"

  [[ "$BACKEND_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
    || die "BACKEND_USER is not a safe Linux account name."
  id "$BACKEND_USER" &>/dev/null \
    || die "User '$BACKEND_USER' does not exist."

  step "Checking prerequisites"
  check_cmd() { command -v "$1" &>/dev/null || die "'$1' not found. $2"; success "$1 found"; }
  check_cmd node    "Install Node.js 20.19+ or 22.12+ from https://nodejs.org/"
  check_cmd pnpm    "Install pnpm: npm install -g pnpm"
  check_cmd go      "Install Go ≥ 1.25 from https://go.dev/dl/"

  NODE_VERSION_RAW=$(node --version)
  NODE_VERSION_RAW="${NODE_VERSION_RAW#v}"
  IFS=. read -r NODE_MAJOR NODE_MINOR _ <<< "$NODE_VERSION_RAW"
  if ! (( (NODE_MAJOR == 20 && NODE_MINOR >= 19) || (NODE_MAJOR == 22 && NODE_MINOR >= 12) || NODE_MAJOR > 22 )); then
    die "Node.js 20.19+ or 22.12+ required, found $(node --version)"
  fi
  GO_VERSION_RAW=$(cd "$APP_DIR/apps/root-worker" && go env GOVERSION)
  GO_VERSION_RAW="${GO_VERSION_RAW#go}"
  IFS=. read -r GO_MAJOR GO_MINOR _ <<< "$GO_VERSION_RAW"
  if ! (( GO_MAJOR > 1 || (GO_MAJOR == 1 && GO_MINOR >= 25) )); then
    die "Go 1.25+ required, found go$GO_VERSION_RAW"
  fi
  NODE_BIN="$(command -v node)"

  info "Repo:         $APP_DIR"
  info "Backend user: $BACKEND_USER"
  info "Backend port: $BACKEND_PORT"

# =============================================================================
# RELEASE MODE: resolve version, create system user, install node via nvm
# =============================================================================
else

  VERSION="${VERSION:-}"
  INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
  APP_USER="${APP_USER:-${APP_NAME}}"
  NODE_VERSION="22"

  [[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
    || die "APP_USER is not a safe Linux account name."

  # Release archives have a stable `hsi-*` filename and internal worker name;
  # APP_NAME only namespaces the installed services and destination paths.
  [[ "$INSTALL_DIR" == /* ]] || die "INSTALL_DIR must be an absolute path."
  command -v realpath &>/dev/null || die "'realpath' not found. Install coreutils."
  INSTALL_DIR=$(realpath -m -- "$INSTALL_DIR")
  [[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || die "INSTALL_DIR contains unsupported characters."
  [[ -n "$INSTALL_DIR" && "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "/opt" && "$INSTALL_DIR" != "/usr" &&
     "$INSTALL_DIR" != "/var" && "$INSTALL_DIR" != "/home" && "$INSTALL_DIR" != "/root" ]] \
    || die "INSTALL_DIR must be a dedicated application directory, not a system root."
  INSTALL_PARENT=$(dirname "$INSTALL_DIR")
  [[ "$INSTALL_PARENT" != "/" ]] \
    || die "INSTALL_DIR must be nested under a dedicated parent (for example /opt/$APP_NAME)."
  [[ ! -e "$INSTALL_DIR" || -d "$INSTALL_DIR" ]] \
    || die "INSTALL_DIR exists but is not a directory: $INSTALL_DIR"
  if [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
    [[ -L "$INSTALL_DIR/current" || -d "$INSTALL_DIR/releases" \
       || ( -f "$INSTALL_DIR/server.js" && -d "$INSTALL_DIR/database/prisma" \
            && ( -f "$INSTALL_DIR/VERSION" || -f "$INSTALL_DIR/.env" ) ) ]] \
      || die "INSTALL_DIR is non-empty and is not a recognized HSI installation: $INSTALL_DIR"
  fi
  [[ ! -L "$INSTALL_DIR" && ! -L "$INSTALL_DIR/releases" ]] \
    || die "INSTALL_DIR and its releases folder must be real directories, not links."


  step "Resolving release version"
  if [[ -z "$VERSION" ]]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -oP '"tag_name":\s*"\K[^"]+')
    [[ -n "$VERSION" ]] || die "Could not fetch latest release from GitHub."
  fi
  VERSION="v${VERSION#v}"
  [[ "$VERSION" =~ $INSTALLED_VERSION_RE ]] \
    || die "Invalid release version: $VERSION"
  ! version_lt "$VERSION" "$FIRST_SAFE_UPDATE_VERSION" \
    || die "This installer installs $FIRST_SAFE_UPDATE_VERSION or newer. To install $VERSION, run the install.sh of that release."
  APP_DIR="$INSTALL_DIR"

  info "Version:      $VERSION"
  info "Install dir:  $INSTALL_DIR"
  info "Run as user:  $APP_USER"
  info "Backend port: $BACKEND_PORT"

  step "Setting up system user"
  if id "$APP_USER" &>/dev/null; then
    success "User '$APP_USER' already exists"
  else
    useradd -r -m -s /usr/sbin/nologin "$APP_USER"
    success "Created system user '$APP_USER'"
  fi

  APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)
  NVM_DIR="$APP_HOME/.nvm"

  app_exec() {
    run_as "$APP_USER" "
      export HOME='$APP_HOME'
      export NVM_DIR='$NVM_DIR'
      export CHECKPOINT_DISABLE=1
      [[ -s '$NVM_DIR/nvm.sh' ]] && source '$NVM_DIR/nvm.sh'
      $*
    "
  }

  # generate_prisma_client <release dir>: as the app user, in that release.
  generate_prisma_client() {
    local dir=$1
    app_exec "
      cd '$dir/database'
      NODE_PATH='$dir/node_modules' \
        PRISMA_SCHEMA_ENGINE_BINARY='$dir/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x' \
        PRISMA_QUERY_ENGINE_LIBRARY='$dir/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node' \
        '$dir/node_modules/.bin/prisma' generate
    "
  }

  step "Installing Node.js $NODE_VERSION via nvm"
  if [[ ! -f "$NVM_DIR/nvm.sh" ]]; then
    run_as "$APP_USER" "
      export HOME='$APP_HOME'
      export NVM_DIR='$NVM_DIR'
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    "
    success "nvm installed"
  else
    warn "nvm already installed, skipping"
  fi

  app_exec "nvm install $NODE_VERSION && nvm alias default $NODE_VERSION"
  NODE_BIN=$(app_exec "nvm which $NODE_VERSION")
  success "Node: $NODE_BIN"

  # Download, verify, fully extract and validate the release before stopping a
  # running installation. Network, signature or archive failures leave it untouched.
  step "Downloading and verifying $VERSION"
  DL_DIR=$(mktemp -d)
  stage_release
  # An update killed midway is rolled back before anything else (the recovery takes
  # the lock itself).
  if [[ -f "$UPDATE_STATE/in-progress.json" ]]; then
    flock -u 9
    recover_interrupted_update
    flock -n 9 || die "Another update or rollback is running; wait for it to finish, then re-run."
  fi
  RELEASE_WORKER_BIN="${RELEASE_APP_NAME}-worker"
  [[ -f "$RELEASE_STAGE/server.js" \
     && -f "$RELEASE_STAGE/public/index.html" \
     && -x "$RELEASE_STAGE/bin/$RELEASE_WORKER_BIN" \
     && -d "$RELEASE_STAGE/database/prisma" \
     && -d "$RELEASE_STAGE/compose/src" \
     && -x "$RELEASE_STAGE/node_modules/.bin/prisma" \
     && -x "$RELEASE_STAGE/node_modules/.bin/tsx" \
     && -x "$RELEASE_STAGE/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x" \
     && -s "$RELEASE_STAGE/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node" \
     && -f "$RELEASE_STAGE/runtime/package-lock.json" ]] \
    || die "Release archive is incomplete."
  success "Release downloaded and validated"

fi

# =============================================================================
# COMMON: detect fresh install vs update
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  DB_DIR="$APP_DIR/packages/database/data"
  SCHEMA_DIR="$APP_DIR/packages/database/prisma/schema"
else
  DB_DIR="$APP_DIR/database/data"
  if [[ -d "$APP_DIR/database/prisma/schema" ]]; then
    SCHEMA_DIR="$APP_DIR/database/prisma/schema"
  else
    SCHEMA_DIR="$RELEASE_STAGE/database/prisma/schema"
  fi
fi
# The DB filename comes from the Prisma datasource, which is independent of
# APP_NAME (e.g. the schema targets hsi.db while APP_NAME=app). Derive it from
# the schema so update-detection and the pre-push backup point at the REAL DB;
# using "${APP_NAME}.db" blindly would miss it, mis-detect a fresh install, and
# skip the data migrations below. Fall back only when no schema is on disk yet
# (a true first install, nothing extracted).
DB_URL_PATH=$(grep -rhoP 'url\s*=\s*"file:\K[^"]+' "$SCHEMA_DIR" 2>/dev/null | head -1)
if [[ -n "$DB_URL_PATH" ]]; then
  DB_FILE="$DB_DIR/$(basename "$DB_URL_PATH")"
else
  DB_FILE="$DB_DIR/${APP_NAME}.db"
fi
ENV_FILE="$APP_DIR/.env"

check_data_paths
if [[ -f "$DB_FILE" ]]; then
  IS_UPDATE=1
  warn "Existing installation detected, performing update (data preserved)"
else
  IS_UPDATE=0
  info "Fresh installation"
fi

# =============================================================================
# COMMON: stop running services before updating
# =============================================================================
if [[ "$IS_UPDATE" -eq 1 ]]; then
  step "Stopping services before update"
  systemctl stop "${APP_NAME}-server" "${APP_NAME}-worker" "${APP_NAME}" "${APP_NAME}-root-worker" 2>/dev/null || true
  SERVICES_STOPPED=1
  success "Application services stopped"
fi

# =============================================================================
# SOURCE MODE: pnpm install, Go build, TypeScript build
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then

  step "Installing pnpm dependencies"
  run_as "$APP_USER" "cd '$APP_DIR' && pnpm install --frozen-lockfile --filter '!@app/website'"
  success "Dependencies installed"

  step "Building worker"
  (
    cd "$APP_DIR/apps/root-worker"
    CGO_ENABLED=0 go build -ldflags="-s -w" -o "${APP_NAME}-worker" .
  )
  install -m 755 "$APP_DIR/apps/root-worker/${APP_NAME}-worker" "/usr/local/bin/${APP_NAME}-worker"
  success "Installed: /usr/local/bin/${APP_NAME}-worker"
  install_restic || true

  step "Building backend"
  run_as "$APP_USER" "cd '$APP_DIR' && pnpm --filter @app/backend build"
  success "Backend bundled → apps/backend/dist/server.js"

  step "Building dashboard"
  # The backend serves the dashboard itself, so the API is always same-origin.
  VITE_API_URL="/trpc"
  printf 'VITE_API_URL=%s\n' "$VITE_API_URL" > "$APP_DIR/apps/dashboard/.env.production"
  run_as "$APP_USER" "cd '$APP_DIR/apps/dashboard' && pnpm build"
  success "Dashboard built → apps/dashboard/dist/"

  BACKEND_DIST="$APP_DIR/apps/backend/dist/server.js"
  DASHBOARD_DIST="$APP_DIR/apps/dashboard/dist"
  DB_WORK_DIR="$APP_DIR/packages/database"
  SERVER_DIR="$APP_DIR"
  WORKER_BIN="$SYSTEM_WORKER"

# =============================================================================
# RELEASE MODE: keep the previous version, snapshot, install side by side
# =============================================================================
else

  # INSTALL_DIR, releases/ and every release are root's: the worker in them runs as
  # root. The app user keeps what it writes: database/data, data and .env. INSTALL_DIR
  # is root's first, so nothing in it can be swapped for a link after the check.
  step "Installing verified release"
  mkdir -p "$INSTALL_DIR"
  chown -h root:root "$INSTALL_DIR"
  chmod 755 "$INSTALL_DIR"
  check_data_paths
  mkdir -p "$INSTALL_DIR/releases" "$INSTALL_DIR/database"
  chown -h root:root "$INSTALL_DIR/releases" "$INSTALL_DIR/database"
  chmod 755 "$INSTALL_DIR/releases" "$INSTALL_DIR/database"
  mkdir -p "$DB_DIR" "$INSTALL_DIR/data"
  chown -h "$APP_USER:" "$DB_DIR" "$INSTALL_DIR/data"

  if [[ "$IS_UPDATE" -eq 1 ]]; then
    # The first update after #9a turns the flat install into releases/<its version>.
    if is_flat_install; then
      convert_flat_install || die "Could not move the installed version under $INSTALL_DIR/releases."
      success "Previous version kept as $INSTALL_DIR/releases/$OLD_VERSION"
    else
      OLD_VERSION=$(basename "$(readlink "$INSTALL_DIR/current")")
    fi
    [[ "$OLD_VERSION" =~ $INSTALLED_VERSION_RE && -d "$INSTALL_DIR/releases/$OLD_VERSION" ]] \
      || die "The installed version could not be determined from $INSTALL_DIR/current."
  fi
  link_flat_paths || die "Could not link the code paths of $INSTALL_DIR through current."
  # Leftovers of the file-by-file rollback of installers before #9a.
  rm -rf -- "$INSTALL_DIR"/.install-rollback-*

  # The worker of the verified release: root runs nothing the app user can change.
  NEW_WORKER="$RELEASE_STAGE/bin/$RELEASE_WORKER_BIN"
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    # Taken while everything is stopped, by descriptor without following links,
    # also for a version before #9a (whose own worker has no `update` command).
    # From the marker on, every failure rolls back.
    step "Snapshotting the database and configuration"
    SNAP=$(worker_update "$NEW_WORKER" snapshot "$OLD_VERSION" "$VERSION") \
      || die "Could not snapshot the installation."
    success "Snapshot → $SNAP"
    mark_update install
  fi

  # The Prisma client is generated by the app user in the staging copy, before the
  # release becomes root's: root never runs node or anything under the app user's
  # home. Later Prisma commands run as the app user and skip generation.
  step "Installing $VERSION and generating its Prisma client"
  install_release_dir generate_prisma_client || die "Could not install $VERSION in $INSTALL_DIR/releases."
  REL_DIR="$INSTALL_DIR/releases/$VERSION"
  NEW_WORKER="$REL_DIR/bin/$RELEASE_WORKER_BIN"
  success "Installed in $REL_DIR"

  step "Installing worker binary"
  # Through current, so the worker always matches the active release.
  ln -sfn "$INSTALL_DIR/current/bin/$RELEASE_WORKER_BIN" "$SYSTEM_WORKER"
  success "Linked: $SYSTEM_WORKER → $INSTALL_DIR/current/bin/$RELEASE_WORKER_BIN"
  install_restic || true

  PRISMA_BIN="$REL_DIR/node_modules/.bin/prisma"
  TSX_BIN="$REL_DIR/node_modules/.bin/tsx"
  PRISMA_SCHEMA_ENGINE_BIN="$REL_DIR/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x"
  PRISMA_QUERY_ENGINE_LIB="$REL_DIR/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"

  SERVER_DIR="$INSTALL_DIR/current"
  BACKEND_DIST="$INSTALL_DIR/current/server.js"
  DASHBOARD_DIST="$INSTALL_DIR/current/public"
  DB_WORK_DIR="$REL_DIR/database"
  WORKER_BIN="$NEW_WORKER"

fi

# =============================================================================
# COMMON: database setup
# =============================================================================
step "Setting up database"
mkdir -p "$DB_DIR"
chown -h "$APP_USER:" "$DB_DIR"

# ── Declarative container stacks ─────────────────────────────────────────────
# The app user owns /opt/containers and writes compose.yaml files directly;
# the root worker only runs docker compose. Needed on BOTH fresh installs and
# updates (the backend creates app dirs in here; without it, mkdir fails with
# EACCES on a fresh install).
CONTAINERS_DIR=/opt/containers
step "Preparing $CONTAINERS_DIR"
mkdir -p "$CONTAINERS_DIR"
chown "$APP_USER" "$CONTAINERS_DIR"

if [[ "$IS_UPDATE" -eq 1 ]]; then
  # As the app user: the folder is its own, so root would follow any link in it.
  BACKUP="$DB_DIR/${APP_NAME}.db.bak-$(date +%Y%m%d-%H%M%S)"
  run_as "$APP_USER" "cp -- '$DB_FILE' '$BACKUP'"
  success "Database backed up → $BACKUP"
  run_as "$APP_USER" "find '$DB_DIR' -maxdepth 1 -type f -name '${APP_NAME}.db.bak-*' -printf '%T@ %p\\0' \
    | sort -zrn | tail -zn +6 | cut -zd' ' -f2- | xargs -0r rm -f --"
  # Release mode restores the database from the update snapshot instead.
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    DB_ROLLBACK_FILE="$BACKUP"
  else
    mark_update migrate
  fi

  # ── Data migrations (idempotent): MUST run BEFORE `db push` ────────────────
  # `db push --accept-data-loss` DROPS any table/column the new schema removed.
  # A migration that folds data out of a soon-to-be-dropped table (e.g. old
  # Role/Permission grants → UserPlacePermission) must therefore run against the
  # OLD shape, before the push, otherwise that data is gone. Each script self-
  # guards and is idempotent, so running the whole directory on every update is
  # safe (already-applied migrations no-op). An absolute DATABASE_URL is passed
  # so the transform hits the live DB regardless of CWD (the schema's relative
  # datasource path would resolve differently from within prisma/data-migrations).
  MIGRATIONS_DIR="$DB_WORK_DIR/prisma/data-migrations"
  if compgen -G "$MIGRATIONS_DIR/*.ts" > /dev/null 2>&1; then
    # The runner imports @prisma/client, generated above in release mode and by
    # the canonical backend prebuild in source mode.
    for m in "$MIGRATIONS_DIR"/*.ts; do
      rel="prisma/data-migrations/$(basename "$m")"
      step "Running data migration: $(basename "$m")"
      if [[ "$FROM_SOURCE" -eq 1 ]]; then
        run_as "$APP_USER" "cd '$DB_WORK_DIR' && DATABASE_URL='file:$DB_FILE' pnpm exec tsx '$rel'"
      else
        app_exec "cd '$DB_WORK_DIR' && DATABASE_URL='file:$DB_FILE' NODE_PATH='$REL_DIR/node_modules' '$TSX_BIN' '$rel'"
      fi
    done
    success "Data migrations applied"
  fi

  # --accept-data-loss is required for column-type changes (e.g. Int -> BigInt);
  # Prisma flags those as lossy even when SQLite preserves the values. The DB was
  # just backed up above, so this is safe, and without the flag such schema
  # changes silently fail on update, leaving the running DB stale.
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    run_as "$APP_USER" "cd '$DB_WORK_DIR' && pnpm exec prisma db push --accept-data-loss"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$REL_DIR/node_modules' PRISMA_SCHEMA_ENGINE_BINARY='$PRISMA_SCHEMA_ENGINE_BIN' PRISMA_QUERY_ENGINE_LIBRARY='$PRISMA_QUERY_ENGINE_LIB' '$PRISMA_BIN' db push --accept-data-loss --skip-generate"
  fi
  success "Schema migrated (existing data preserved)"
else
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    run_as "$APP_USER" "cd '$DB_WORK_DIR' && pnpm exec prisma db push --accept-data-loss"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$REL_DIR/node_modules' PRISMA_SCHEMA_ENGINE_BINARY='$PRISMA_SCHEMA_ENGINE_BIN' PRISMA_QUERY_ENGINE_LIBRARY='$PRISMA_QUERY_ENGINE_LIB' '$PRISMA_BIN' db push --accept-data-loss --skip-generate"
  fi
  success "Schema created"
fi

# Managed HTTPS (#12): a new install serves HTTPS with its own local
# authority; an update keeps how the server was reached (proxy when the
# nginx site of older versions exists, plain HTTP otherwise).
# server.key is handed to the application user's primary group (no "hsi"
# group exists for a source install or a custom APP_USER).
APP_GROUP_NAME="$(id -gn "$APP_USER" 2>/dev/null || echo hsi)"
if [[ "$IS_UPDATE" -eq 1 ]]; then
  "$WORKER_BIN" tls migrate --port "$BACKEND_PORT" --group "$APP_GROUP_NAME" || warn "Could not write the TLS settings"
else
  "$WORKER_BIN" tls init --port "$BACKEND_PORT" --group "$APP_GROUP_NAME" || warn "Could not create the HTTPS certificate: run 'sudo ${APP_NAME}-worker tls reset'"
fi

SETUP_LINK=""
if [[ "${SKIP_SEED}" != "1" ]]; then
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    SEED_OUTPUT=$(run_as "$APP_USER" "cd '$DB_WORK_DIR' && pnpm exec tsx prisma/seed.ts")
  else
    SEED_OUTPUT=$(app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$REL_DIR/node_modules' '$TSX_BIN' prisma/seed.ts")
  fi
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    success "Seed applied (new permissions/roles merged, existing data untouched)"
  else
    success "Database seeded"
  fi
  grep -v '^HSI_SETUP_REQUIRED$' <<<"$SEED_OUTPUT" || true
  # No administrator yet (#12): a one-time link to the setup assistant, which
  # creates it. Installs that already have one get nothing. An update keeps a
  # link not used yet instead of replacing it.
  if grep -q '^HSI_SETUP_REQUIRED$' <<<"$SEED_OUTPUT" \
     && { [[ "$IS_UPDATE" -eq 0 ]] || [[ ! -s /etc/hsi/setup-token ]]; }; then
    SETUP_HOST=$(hostname -I | awk '{print $1}')
    if SETUP_LINK=$("$WORKER_BIN" setup-token ${SETUP_HOST:+--host "$SETUP_HOST"}); then
      success "Setup link created"
    else
      SETUP_LINK=""
      warn "Could not create the setup link: run 'sudo ${APP_NAME}-worker setup-token' once the install is done"
    fi
  fi
fi

# =============================================================================
# COMMON: generate JWT secret and backend .env
# =============================================================================
step "Generating secrets"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists, keeping existing secrets"
else
  JWT_SECRET=$(openssl rand -hex 32)
  printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$JWT_SECRET" > "$ENV_FILE"
  success "Generated JWT secret → $ENV_FILE"
fi
# Encrypts notification connector secrets. Added to existing installs too;
# never regenerated, or stored secrets would become unreadable.
if ! grep -q '^HSI_SECRETS_KEY=' "$ENV_FILE"; then
  printf 'HSI_SECRETS_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
  success "Generated notification secrets key → $ENV_FILE"
fi
chown -h "$APP_USER:" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# =============================================================================
# COMMON: install NATS server binary
# =============================================================================
step "Installing NATS server ($NATS_SERVER_VERSION)"

if command -v nats-server &>/dev/null && \
   nats-server --version 2>/dev/null | grep -qF "${NATS_SERVER_VERSION#v}"; then
  success "nats-server $NATS_SERVER_VERSION already installed"
else
  NATS_TMP=$(mktemp -d)
  NATS_DL="https://github.com/nats-io/nats-server/releases/download/${NATS_SERVER_VERSION}/nats-server-${NATS_SERVER_VERSION}-linux-amd64.tar.gz"
  curl -fsSL --progress-bar "$NATS_DL" -o "$NATS_TMP/nats.tar.gz" \
    || die "Failed to download nats-server"
  tar -xzf "$NATS_TMP/nats.tar.gz" -C "$NATS_TMP" --strip-components=1
  systemctl stop "${APP_NAME}-nats" 2>/dev/null || true
  install -m 755 "$NATS_TMP/nats-server" /usr/local/bin/nats-server
  rm -rf "$NATS_TMP"
  success "Installed: /usr/local/bin/nats-server"
fi

if ! id "nats" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin nats
  success "Created system user 'nats'"
fi

# =============================================================================
# COMMON: configure NATS (credentials, nats.conf, worker.env)
# =============================================================================
step "Configuring NATS"

NATS_DATA_DIR="/var/lib/${APP_NAME}/nats"

mkdir -p "$APP_CONF_DIR" "$NATS_DATA_DIR"
chown nats: "$NATS_DATA_DIR"

if [[ ! -f "$APP_CONF_DIR/.nats-credentials" ]]; then
  NATS_BACKEND_PASS=$(openssl rand -hex 32)
  NATS_WORKER_PASS=$(openssl rand -hex 32)
  printf 'NATS_BACKEND_PASS=%s\nNATS_WORKER_PASS=%s\n' \
    "$NATS_BACKEND_PASS" "$NATS_WORKER_PASS" \
    > "$APP_CONF_DIR/.nats-credentials"
  chmod 600 "$APP_CONF_DIR/.nats-credentials"
  success "Generated NATS credentials → $APP_CONF_DIR/.nats-credentials"
else
  warn "NATS credentials already exist, reusing"
fi

# shellcheck source=/dev/null
source "$APP_CONF_DIR/.nats-credentials"

cat > "$NATS_CONF" <<EOF
# NATS configuration, generated by install.sh on $(date)
max_payload: 67108864  # 64 MB

jetstream {
  store_dir: "$NATS_DATA_DIR"
}

authorization {
  users: [
    {
      user: "backend"
      password: "$NATS_BACKEND_PASS"
      permissions: {
        publish:   [ "root.>", "_INBOX.>", "\$JS.>" ]
        subscribe: [ "events.>", "_INBOX.>", "\$JS.>" ]
      }
    }
    {
      user: "worker"
      password: "$NATS_WORKER_PASS"
      permissions: {
        # root.health: the update health gate asks the running worker with
        # these credentials.
        publish:   [ "events.>", "root.health", "_INBOX.>", "\$JS.>" ]
        subscribe: [ "root.>", "_INBOX.>", "\$JS.>" ]
      }
    }
  ]
}
EOF
chmod 640 "$NATS_CONF"
chown root:nats "$NATS_CONF"
success "NATS config → $NATS_CONF"

# Configuration backups (#1) are staged in a directory only the backend user
# and root can read; it must exist before the backend unit names it.
BACKUP_STAGING_DIR="/var/lib/${APP_NAME}/backup-staging"
install -d -m 0700 -o "$APP_USER" "$BACKUP_STAGING_DIR"

# Keep a log level the admin set in worker.env across updates.
WORKER_LOG_LEVEL="${HSI_LOG_LEVEL:-$(grep -s '^HSI_LOG_LEVEL=' "$WORKER_ENV" | cut -d= -f2 || true)}"
[[ "${WORKER_LOG_LEVEL:-info}" =~ ^(debug|info|warn|error)$ ]] || WORKER_LOG_LEVEL=info
cat > "$WORKER_ENV" <<EOF
NATS_URL=nats://127.0.0.1:4222
NATS_USER=worker
NATS_PASS=$NATS_WORKER_PASS
HSI_LOG_LEVEL=${WORKER_LOG_LEVEL:-info}
HSI_MAINTENANCE_CONFIG=$APP_CONF_DIR/maintenance.json
HSI_MAINTENANCE_STATE=/var/lib/${APP_NAME}/maintenance-state.json
HSI_MAINTENANCE_TIMER=/etc/systemd/system/${APP_NAME}-maintenance.timer
HSI_BACKEND_ENV=$ENV_FILE
HSI_BACKUP_STAGING=$BACKUP_STAGING_DIR
HSI_UNIT_PREFIX=${APP_NAME}
HSI_BACKUP_CONFIG=$BACKUP_CONFIG
HSI_BACKUP_SECRETS=$APP_CONF_DIR/backup
HSI_BACKUP_STATE=/var/lib/${APP_NAME}/backup
HSI_BACKUP_LOCKS=/run/${APP_NAME}/backup
HSI_RESTIC=$RESTIC_DEST
HSI_INSTALL_DIR=$APP_DIR
HSI_UPDATE_STATE=$UPDATE_STATE
HSI_WORKER_ENV=$WORKER_ENV
HSI_NATS_CONF=$NATS_CONF
HSI_UPDATE_DB=$DB_FILE
EOF
chmod 600 "$WORKER_ENV"
success "Worker env → $WORKER_ENV"

for VAR in NATS_URL NATS_USER NATS_PASS; do
  sed -i "/^${VAR}=/d" "$ENV_FILE"
done
cat >> "$ENV_FILE" <<EOF
NATS_URL=nats://127.0.0.1:4222
NATS_USER=backend
NATS_PASS=$NATS_BACKEND_PASS
EOF
success "Backend NATS credentials → $ENV_FILE"

# =============================================================================
# COMMON: install systemd services
# =============================================================================
step "Installing systemd services"

# Backend + worker write their stdout/stderr to files here instead of the
# systemd journal, so operators have plain log files to tail/ship.
LOG_DIR="/var/log/${APP_NAME}"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$LOG_DIR"

# Keep those files from growing unbounded. copytruncate because systemd holds
# the file open (StandardOutput=append:); no service restart needed to rotate.
cat > /etc/logrotate.d/${APP_NAME} <<ROTATE
$LOG_DIR/*.log {
  weekly
  rotate 8
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
ROTATE

migrate_service_names

# The stack: hsi.target starts, stops and restarts NATS, the worker and the
# server together (PartOf=); each service can still be managed on its own.
# Only the target is enabled at boot. Timers and the update units stay
# outside, so stopping the stack never kills a running update.
cat > /etc/systemd/system/${APP_NAME}.target <<EOF
[Unit]
Description=${APP_NAME} stack (NATS, worker, server)
Wants=${APP_NAME}-nats.service ${APP_NAME}-worker.service ${APP_NAME}-server.service
After=${APP_NAME}-nats.service ${APP_NAME}-worker.service ${APP_NAME}-server.service

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/${APP_NAME}-nats.service <<EOF
[Unit]
Description=${APP_NAME} NATS JetStream Server
After=network.target
PartOf=${APP_NAME}.target

[Service]
ExecStart=/usr/local/bin/nats-server --config $NATS_CONF
ExecStartPost=/bin/bash -c 'for i in \$(seq 1 30); do bash -c "echo >/dev/tcp/127.0.0.1/4222" 2>/dev/null && exit 0; sleep 1; done; exit 1'
User=nats
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}-nats

[Install]
WantedBy=${APP_NAME}.target
EOF

cat > /etc/systemd/system/${APP_NAME}-worker.service <<EOF
[Unit]
Description=${APP_NAME} worker (root)
After=network.target ${APP_NAME}-nats.service
Requires=${APP_NAME}-nats.service
PartOf=${APP_NAME}.target

[Service]
ExecStart=/usr/local/bin/${APP_NAME}-worker
User=root
EnvironmentFile=$WORKER_ENV
NoNewPrivileges=no
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/root-worker.log
StandardError=append:$LOG_DIR/root-worker.log
SyslogIdentifier=${APP_NAME}-worker

[Install]
WantedBy=${APP_NAME}.target
EOF

# Scheduled disk checks (SMART self-tests, RAID consistency checks). Runs the
# worker binary directly, so schedules keep running when the backend is down.
# Settings: Storage > Maintenance (stored in $APP_CONF_DIR/maintenance.json).
mkdir -p "/var/lib/${APP_NAME}"
cat > /etc/systemd/system/${APP_NAME}-maintenance.service <<EOF
[Unit]
Description=${APP_NAME} scheduled disk checks

[Service]
Type=oneshot
ExecStart=/usr/local/bin/${APP_NAME}-worker maintenance
EnvironmentFile=$WORKER_ENV
Nice=10
IOSchedulingClass=idle
StandardOutput=append:$LOG_DIR/root-worker.log
StandardError=append:$LOG_DIR/root-worker.log
SyslogIdentifier=${APP_NAME}-maintenance
EOF

# Versioned backups (#15): one timer per plan or repository, created by the
# worker, instantiates these templates.
cat > /etc/systemd/system/${APP_NAME}-backup@.service <<EOF
[Unit]
Description=${APP_NAME} backup plan %i
After=network-online.target ${APP_NAME}-worker.service docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/${APP_NAME}-worker backup run %i
EnvironmentFile=$WORKER_ENV
# An interrupted run starts the apps it stopped again before it exits: only the
# worker gets SIGTERM (it passes it on to restic), never a docker compose child.
KillMode=mixed
TimeoutStopSec=120s
Nice=10
IOSchedulingClass=idle
StandardOutput=append:$LOG_DIR/backup.log
StandardError=append:$LOG_DIR/backup.log
SyslogIdentifier=${APP_NAME}-backup
EOF

cat > /etc/systemd/system/${APP_NAME}-backup-check@.service <<EOF
[Unit]
Description=${APP_NAME} repository check %i
After=network-online.target ${APP_NAME}-worker.service docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/${APP_NAME}-worker backup check %i
EnvironmentFile=$WORKER_ENV
# An interrupted run starts the apps it stopped again before it exits: only the
# worker gets SIGTERM (it passes it on to restic), never a docker compose child.
KillMode=mixed
TimeoutStopSec=120s
Nice=10
IOSchedulingClass=idle
StandardOutput=append:$LOG_DIR/backup.log
StandardError=append:$LOG_DIR/backup.log
SyslogIdentifier=${APP_NAME}-backup-check
EOF

cat > /etc/systemd/system/${APP_NAME}-maintenance.timer <<EOF
[Unit]
Description=Hourly check for due ${APP_NAME} disk maintenance

[Timer]
OnCalendar=hourly
Persistent=false

[Install]
WantedBy=timers.target
EOF

if [[ "$FROM_SOURCE" -eq 1 ]]; then
  SOURCE_EXTRA="Environment=DASHBOARD_PATH=${DASHBOARD_DIST}"
else
  SOURCE_EXTRA="Environment=INSTALL_DIR=${INSTALL_DIR}"
fi

cat > /etc/systemd/system/${APP_NAME}-server.service <<EOF
[Unit]
Description=${APP_NAME} server
Documentation=https://github.com/${REPO}
After=network.target ${APP_NAME}-nats.service ${APP_NAME}-worker.service
Requires=${APP_NAME}-nats.service ${APP_NAME}-worker.service
PartOf=${APP_NAME}.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$SERVER_DIR
EnvironmentFile=$ENV_FILE
$SOURCE_EXTRA
Environment=BACKEND_PORT=$BACKEND_PORT
ExecStart=$NODE_BIN $BACKEND_DIST
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/app.log
SyslogIdentifier=${APP_NAME}-server

NoNewPrivileges=true
# Ports below 1024 (HTTPS on 443) without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ProtectSystem=strict
ProtectHome=read-only
# The certificate and key are written by the root worker; the backend only reads them.
ReadOnlyPaths=-/var/lib/hsi/tls
# CONTAINERS_DIR: the backend writes compose.yaml files itself (containerStacks.ts);
# without it ProtectSystem=strict makes /opt read-only and App Store installs fail.
# BACKUP_STAGING_DIR: configuration backups and restores are staged there (#1).
ReadWritePaths=$DB_DIR $APP_DIR /tmp $LOG_DIR $CONTAINERS_DIR $BACKUP_STAGING_DIR

[Install]
WantedBy=${APP_NAME}.target
EOF

# Release mode: current switches to the new release with a rename, so it is never
# missing; until here the previous version could still start from it.
if [[ "$FROM_SOURCE" -eq 0 ]]; then
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    mark_update switch
  fi
  worker_update "$NEW_WORKER" switch "$VERSION" || die "Could not switch $INSTALL_DIR/current to $VERSION."
  success "$INSTALL_DIR/current → releases/$VERSION"
fi

systemctl daemon-reload
systemctl enable "${APP_NAME}.target"
systemctl enable --now "${APP_NAME}-maintenance.timer"
# Restart each service explicitly so it runs the new files even when the
# target was already active, then make sure the target itself is started.
systemctl restart "${APP_NAME}-nats" "${APP_NAME}-worker" "${APP_NAME}-server"
systemctl start "${APP_NAME}.target"
SERVICES_STOPPED=0
DB_ROLLBACK_FILE=""
success "All services started"

# =============================================================================
# RELEASE MODE: install update checker (systemd timer + path unit)
# =============================================================================
if [[ "$FROM_SOURCE" -eq 0 ]]; then
  step "Installing update checker"
  # The check result now lives in the app-owned data dir: a fresh install
  # cannot create files in INSTALL_DIR, which the release copy leaves root-owned.
  rm -f "$INSTALL_DIR/.update-check.json"

  cat > /usr/local/bin/${APP_NAME}-check-update <<CHECKEOF
#!/usr/bin/env bash
REPO="${REPO}"
INSTALL_DIR="\${INSTALL_DIR:-${INSTALL_DIR}}"
latest=\$(curl -fsSL --max-time 15 \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/repos/\${REPO}/releases/latest" \\
  | grep -oP '"tag_name":\s*"\K[^"]+' || true)
[[ -n "\$latest" ]] || { echo "update check: could not read the latest release from GitHub" >&2; exit 0; }
printf '{"latestVersion":"%s","checkedAt":"%s"}\n' \\
  "\$latest" "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
  > "${DB_DIR}/.update-check.json"
CHECKEOF
  chmod 755 /usr/local/bin/${APP_NAME}-check-update

  cat > /etc/systemd/system/${APP_NAME}-update-check.service << EOF
[Unit]
Description=${APP_NAME} update check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$APP_USER
Environment=INSTALL_DIR=$INSTALL_DIR
ExecStart=/usr/local/bin/${APP_NAME}-check-update
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}-update-check
EOF

  cat > /etc/systemd/system/${APP_NAME}-update-check.timer << EOF
[Unit]
Description=Daily ${APP_NAME} update check

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

  # The worker downloads and verifies the requested release, then runs the
  # install.sh from it. It runs here, outside the stack the update stops. The
  # marker is written by the backend: only its first line is read, and the worker
  # refuses anything but a vX.Y.Z version.
  cat > /etc/systemd/system/${APP_NAME}-update-apply.service << EOF
[Unit]
Description=Apply pending ${APP_NAME} update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
EnvironmentFile=$WORKER_ENV
Environment=APP_NAME=${APP_NAME}
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=APP_USER=${APP_USER}
Environment=BACKEND_PORT=${BACKEND_PORT}
Environment=NATS_SERVER_VERSION=${NATS_SERVER_VERSION}
Environment=SKIP_NGINX=${SKIP_NGINX}
Environment=SKIP_SEED=${SKIP_SEED}
ExecStart=/bin/bash -c 'read -r -n 64 v < "${DB_DIR}/.pending-update"; rm -f "${DB_DIR}/.pending-update"; exec ${SYSTEM_WORKER} update apply "\$\$v"'
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}-update
EOF

  cat > /etc/systemd/system/${APP_NAME}-update-apply.path << EOF
[Unit]
Description=Watch for pending ${APP_NAME} update

[Path]
PathExists=${DB_DIR}/.pending-update

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now ${APP_NAME}-update-check.timer
  systemctl enable --now ${APP_NAME}-update-apply.path
  success "Update checker enabled"

  # releases/<version>/VERSION, read through the INSTALL_DIR/VERSION link.
  success "Version recorded → $INSTALL_DIR/VERSION ($(cat "$INSTALL_DIR/VERSION"))"

  # Health gate: the new worker waits up to 2 minutes for /health (database up,
  # version $VERSION) and for the running worker to answer root.health. A failed
  # update goes back to the previous version and database.
  step "Checking that $VERSION is healthy"
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    mark_update health
  fi
  if HEALTH_OUT=$(worker_update "$NEW_WORKER" health "$VERSION" --timeout 120 2>&1); then
    if [[ "$IS_UPDATE" -eq 1 ]]; then
      CURRENT_STEP=commit
      worker_update "$NEW_WORKER" commit "$OLD_VERSION" "$VERSION" "$SNAP" \
        || die "Could not record the successful update."
      UPDATE_FINISHED=1
    fi
    success "$VERSION is healthy"
  else
    HEALTH_REASON=$(grep -v '^{' <<<"$HEALTH_OUT" | tail -n 1)
    HEALTH_REASON=${HEALTH_REASON:-$VERSION did not become healthy}
    if [[ "$IS_UPDATE" -eq 1 ]]; then
      rollback_update "$HEALTH_REASON"
      die "The update to $VERSION failed its health checks: $HEALTH_REASON"
    fi
    warn "$VERSION is not healthy yet: $HEALTH_REASON"
  fi
fi

# =============================================================================
# SOURCE MODE: record version from package.json
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  # Read, not run: root executes no code of the checkout here.
  PKG_VERSION=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n 1)
  PKG_VERSION=${PKG_VERSION:-0.0.0}
  echo "v${PKG_VERSION}" > "$APP_DIR/VERSION"
  chown "$APP_USER:" "$APP_DIR/VERSION"
  success "Version recorded → $APP_DIR/VERSION"
fi

cleanup_legacy_app_units

# =============================================================================
# COMMON: nginx reverse proxy (only kept up to date where an older version
# already set it up and the server is still reached through it: proxy mode
# with the site enabled; new installs are served directly over HTTPS, and a
# site the admin disabled or removed is never brought back)
# =============================================================================
TLS_MODE_NOW=$(sed -n 's/.*"mode": *"\([a-z]*\)".*/\1/p' /var/lib/hsi/tls/tls.json 2>/dev/null || true)
NGINX_ENABLED_LINK="/etc/nginx/sites-enabled/${APP_NAME}"
if [[ "$IS_UPDATE" -eq 1 && "$TLS_MODE_NOW" == "proxy" && -e "$NGINX_ENABLED_LINK" ]] \
   && [[ "$SKIP_NGINX" != "1" ]] && command -v nginx &>/dev/null; then
  step "Configuring nginx"

  NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
  cat > "$NGINX_CONF" <<EOF
# Generated by install.sh on $(date)
server {
    listen 80;
    server_name _;

    location /trpc {
        proxy_pass         http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        client_max_body_size 16m;
    }

    location /files {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        client_max_body_size    100m;
        proxy_request_buffering off;
        proxy_read_timeout      300s;
    }

    location /s/ {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        proxy_buffering         off;
        proxy_read_timeout      300s;
    }

    location /containers/ {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        proxy_set_header        Connection        "";
        proxy_buffering         off;
        proxy_cache             off;
        proxy_read_timeout      1h;
    }

    location /system/ {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        client_max_body_size    256m;
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      300s;
    }

    location = /health {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
    }

    location = /ca.crt {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
    }

    location / {
        root $DASHBOARD_DIST;
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

  # The sites-enabled link already exists (checked above): it is never
  # created or replaced here.
  SITES_ENABLED="/etc/nginx/sites-enabled"
  if [[ -f "$SITES_ENABLED/default" ]]; then
    warn "Disabling nginx default site (conflicts on port 80)"
    rm -f "$SITES_ENABLED/default"
  fi

  nginx -t && systemctl reload nginx
  success "nginx configured → $NGINX_CONF"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
if [[ "$IS_UPDATE" -eq 1 ]]; then
  echo -e "${BOLD}${GREEN}╔═══════════════════════════════════╗"
  echo -e "║   Updated successfully!           ║"
  echo -e "╚═══════════════════════════════════╝${NC}"
else
  echo -e "${BOLD}${GREEN}╔═══════════════════════════════════╗"
  echo -e "║   Installed successfully!         ║"
  echo -e "╚═══════════════════════════════════╝${NC}"
fi
echo ""

SERVER_IP=$(hostname -I | awk '{print $1}')
tls_mode=$(sed -n 's/.*"mode": *"\([a-z]*\)".*/\1/p' /var/lib/hsi/tls/tls.json 2>/dev/null || true)
if [[ "$tls_mode" == "local" || "$tls_mode" == "imported" ]]; then
  echo -e "  ${BOLD}Access:${NC}  https://$SERVER_IP:$BACKEND_PORT"
elif [[ "$tls_mode" == "proxy" && -e "/etc/nginx/sites-enabled/${APP_NAME}" ]]; then
  echo -e "  ${BOLD}Access:${NC}  http://$SERVER_IP"
else
  echo -e "  ${BOLD}Access:${NC}  http://$SERVER_IP:$BACKEND_PORT"
fi
if [[ "$tls_mode" == "local" ]]; then
  echo -e "  ${BOLD}Certificate authority (SHA-256):${NC} $("/usr/local/bin/${APP_NAME}-worker" tls fingerprint 2>/dev/null || true)"
  echo -e "  ${YELLOW}Your browser warns on the first visit: check this fingerprint, then trust the authority (Settings > Secure access).${NC}"
fi

echo ""
if [[ -n "$SETUP_LINK" ]]; then
  echo -e "  ${BOLD}Finish the setup:${NC}  $SETUP_LINK"
  echo -e "  ${YELLOW}This one-time link creates the administrator. Lost it? sudo ${APP_NAME}-worker setup-token${NC}"
  echo ""
fi

echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    systemctl status ${APP_NAME}.target        # whole stack"
echo -e "    systemctl restart ${APP_NAME}.target       # restart everything"
echo -e "    systemctl status ${APP_NAME}-server        # backend"
echo -e "    systemctl status ${APP_NAME}-worker        # privileged worker"
echo -e "    systemctl status ${APP_NAME}-nats          # message bus"
echo -e "    tail -f ${LOG_DIR}/app.log               # backend logs"
echo -e "    tail -f ${LOG_DIR}/root-worker.log       # worker logs"
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  echo -e "    sudo $0 --from-source        # re-run to update"
else
  echo -e "    sudo ${APP_NAME}-worker update apply vX.Y.Z   # update to a release"
  echo -e "    sudo ${APP_NAME}-worker update rollback        # back to the previous version"
fi
echo ""

if [[ "$LEGACY_MIGRATED" -eq 1 ]]; then
  echo ""
  echo -e "  ${YELLOW}Migrated legacy 'app' install -> 'hsi'${NC} (log: $MIGRATE_LOG)"
fi
