#!/usr/bin/env bash
# =============================================================================
# Build & Install Script
# =============================================================================
# Two modes:
#
#   Release (default) — downloads a pre-built tarball from GitHub:
#     sudo bash install.sh
#     curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/install.sh | sudo bash
#
#   Source — builds and installs from the local repository:
#     sudo ./scripts/install.sh --from-source [BACKEND_USER]
#
# Re-run at any time to update; existing data and secrets are preserved.
#
# Environment overrides (both modes):
#   APP_NAME              App identifier             (default: hsi)
#   BACKEND_PORT          API port                   (default: 9001)
#   NATS_SERVER_VERSION   NATS binary version        (default: v2.10.24)
#   SKIP_NGINX            Set to 1 to skip nginx     (default: 0)
#   SKIP_SEED             Set to 1 to skip DB seed   (default: 0)
#
# Release-mode overrides:
#   VERSION               Release tag to install     (default: latest)
#   INSTALL_DIR           Installation directory     (default: /opt/APP_NAME)
#   APP_USER              System user to run as      (default: APP_NAME)
# =============================================================================

set -euo pipefail

APP_NAME="${APP_NAME:-hsi}"
REPO="kittyruntime/home-server-interface"
RELEASE_APP_NAME="hsi"

# ── Mode detection ─────────────────────────────────────────────────────────────
FROM_SOURCE=0
if [[ "${1:-}" == "--from-source" ]]; then
  FROM_SOURCE=1
  shift
fi

# ── Common environment ─────────────────────────────────────────────────────────
BACKEND_PORT="${BACKEND_PORT:-9001}"
NATS_SERVER_VERSION="${NATS_SERVER_VERSION:-v2.10.24}"
SKIP_NGINX="${SKIP_NGINX:-0}"
SKIP_SEED="${SKIP_SEED:-0}"

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "  ${CYAN}··${NC}  $*"; }
success() { echo -e "  ${GREEN}✓${NC}   $*"; }
warn()    { echo -e "  ${YELLOW}!${NC}   $*"; }
die()     { echo -e "\n  ${RED}✗ error:${NC} $*\n" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▶ $*${NC}"; }

DL_DIR=""
RELEASE_STAGE=""
ROLLBACK_DIR=""
DB_ROLLBACK_FILE=""
SERVICES_STOPPED=0
CORE_INSTALL_COMPLETE=0
ROLLBACK_REL_PATHS=()

cleanup_install_exit() {
  local status=$?
  set +e
  if (( status != 0 )); then
    if (( SERVICES_STOPPED == 1 )); then
      systemctl stop "${APP_NAME}" "${APP_NAME}-root-worker" >/dev/null 2>&1 || true
    fi
    if [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR" ]]; then
      warn "Install failed — restoring the previous application files."
      local rel target backup
      for rel in "${ROLLBACK_REL_PATHS[@]}"; do
        target="$INSTALL_DIR/$rel"
        backup="$ROLLBACK_DIR/$rel"
        rm -rf -- "$target"
        if [[ -e "$backup" || -L "$backup" ]]; then
          mkdir -p "$(dirname "$target")"
          mv -- "$backup" "$target"
        fi
      done
      if [[ -f "$ROLLBACK_DIR/system-root-worker" ]]; then
        install -m 755 "$ROLLBACK_DIR/system-root-worker" "/usr/local/bin/${APP_NAME}-root-worker"
      fi
    fi
    if [[ -n "$DB_ROLLBACK_FILE" && -f "$DB_ROLLBACK_FILE" && -n "${DB_FILE:-}" ]]; then
      warn "Restoring the pre-update database backup."
      cp -- "$DB_ROLLBACK_FILE" "$DB_FILE"
      chown "$APP_USER:" "$DB_FILE"
    fi
    if (( SERVICES_STOPPED == 1 )); then
      warn "Restarting the previous services after the failed update."
      systemctl start "${APP_NAME}-nats" "${APP_NAME}-root-worker" "${APP_NAME}" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR" && $CORE_INSTALL_COMPLETE -eq 1 ]]; then
    rm -rf -- "$ROLLBACK_DIR"
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
[[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0"

# ── Legacy "app" install migration (app -> hsi rename) ────────────────────────
# Older installs used APP_NAME=app: units app*, /opt/app, user/group "app",
# /etc/app. When this run targets the default "hsi" and such an install is
# present, migrate it in place. Forward-only and idempotent: every step checks
# real on-disk state, so a crashed migration resumes on the next run. Legacy
# unit FILES are only removed in cleanup_legacy_app_units, after the new hsi*
# units are enabled — the box is never left without unit files.
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
    PRE_URL="https://github.com/${REPO}/releases/download/${VERSION}/${RELEASE_APP_NAME}-${VERSION}-linux-amd64.tar.gz"
    curl -fsIL --max-time 30 "$PRE_URL" >/dev/null \
      || die "Release asset not found for ${VERSION} (pre-rename version pin?) - nothing was changed. Re-run without VERSION to use the latest release."
  fi
  migrate_legacy_app_install
fi

echo -e "${BOLD}"
echo "  Install / Update — $(date '+%Y-%m-%d %H:%M')"
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  echo "  Mode: build from source"
else
  echo "  Mode: install from release"
fi
echo -e "${NC}"

# =============================================================================
# SOURCE MODE — resolve paths, check tools, build everything
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
  check_cmd openssl "apt install openssl"
  check_cmd curl    "apt install curl"
  check_cmd rsync   "apt install rsync"
  check_cmd ssh     "apt install openssh-client"

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
# RELEASE MODE — resolve version, create system user, install node via nvm
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
    [[ -f "$INSTALL_DIR/server.js" && -d "$INSTALL_DIR/database/prisma" \
       && ( -f "$INSTALL_DIR/VERSION" || -f "$INSTALL_DIR/.env" ) ]] \
      || die "INSTALL_DIR is non-empty and is not a recognized HSI installation: $INSTALL_DIR"
  fi

  step "Checking prerequisites"
  command -v curl    &>/dev/null || die "'curl' not found. apt install curl"
  command -v openssl &>/dev/null || die "'openssl' not found. apt install openssl"
  command -v rsync   &>/dev/null || die "'rsync' not found. apt install rsync"
  command -v ssh     &>/dev/null || die "'ssh' not found. apt install openssh-client"
  success "Prerequisites satisfied"

  step "Resolving release version"
  if [[ -z "$VERSION" ]]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -oP '"tag_name":\s*"\K[^"]+')
    [[ -n "$VERSION" ]] || die "Could not fetch latest release from GitHub."
  fi
  VERSION="v${VERSION#v}"
  [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] \
    || die "Invalid release version: $VERSION"
  APP_DIR="$INSTALL_DIR"
  TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/${RELEASE_APP_NAME}-${VERSION}-linux-amd64.tar.gz"

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
    sudo -u "$APP_USER" bash -c "
      export HOME='$APP_HOME'
      export NVM_DIR='$NVM_DIR'
      [[ -s '$NVM_DIR/nvm.sh' ]] && source '$NVM_DIR/nvm.sh'
      $*
    "
  }

  step "Installing Node.js $NODE_VERSION via nvm"
  if [[ ! -f "$NVM_DIR/nvm.sh" ]]; then
    sudo -u "$APP_USER" bash -c "
      export HOME='$APP_HOME'
      export NVM_DIR='$NVM_DIR'
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    "
    success "nvm installed"
  else
    warn "nvm already installed — skipping"
  fi

  app_exec "nvm install $NODE_VERSION && nvm alias default $NODE_VERSION"
  NODE_BIN=$(app_exec "nvm which $NODE_VERSION")
  success "Node: $NODE_BIN"

  # Download, fully extract and validate the release before stopping a running
  # installation. Network or archive failures therefore leave it untouched.
  step "Downloading and validating $VERSION"
  DL_DIR=$(mktemp -d)
  TARBALL="$DL_DIR/${RELEASE_APP_NAME}.tar.gz"
  RELEASE_STAGE="$DL_DIR/release"
  ARCHIVE_ROOT="${RELEASE_APP_NAME}-${VERSION}"
  curl -fsSL --progress-bar "$TARBALL_URL" -o "$TARBALL" || die "Download failed: $TARBALL_URL"
  tar -tzf "$TARBALL" | while IFS= read -r entry; do
    [[ "$entry" == "$ARCHIVE_ROOT" || "$entry" == "$ARCHIVE_ROOT/"* ]] || exit 1
    rel="${entry#"$ARCHIVE_ROOT"}"
    rel="${rel#/}"
    [[ "$rel" != ".." && "$rel" != ../* && "$rel" != */../* && "$rel" != */.. ]] || exit 1
  done || die "Release archive has an unsafe or unexpected layout."
  mkdir -p "$RELEASE_STAGE"
  tar -xzf "$TARBALL" --no-same-owner --strip-components=1 -C "$RELEASE_STAGE"
  [[ -f "$RELEASE_STAGE/server.js" \
     && -f "$RELEASE_STAGE/public/index.html" \
     && -x "$RELEASE_STAGE/bin/${RELEASE_APP_NAME}-root-worker" \
     && -d "$RELEASE_STAGE/database/prisma" \
     && -x "$RELEASE_STAGE/node_modules/.bin/prisma" \
     && -x "$RELEASE_STAGE/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x" \
     && -s "$RELEASE_STAGE/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node" \
     && -f "$RELEASE_STAGE/runtime/package-lock.json" ]] \
    || die "Release archive is incomplete."
  success "Release downloaded and validated"

fi

# =============================================================================
# COMMON — detect fresh install vs update
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
# (a true first install — nothing extracted).
DB_URL_PATH=$(grep -rhoP 'url\s*=\s*"file:\K[^"]+' "$SCHEMA_DIR" 2>/dev/null | head -1)
if [[ -n "$DB_URL_PATH" ]]; then
  DB_FILE="$DB_DIR/$(basename "$DB_URL_PATH")"
else
  DB_FILE="$DB_DIR/${APP_NAME}.db"
fi
ENV_FILE="$APP_DIR/.env"

if [[ -f "$DB_FILE" ]]; then
  IS_UPDATE=1
  warn "Existing installation detected — performing update (data preserved)"
else
  IS_UPDATE=0
  info "Fresh installation"
fi

# =============================================================================
# COMMON — stop running services before updating
# =============================================================================
if [[ "$IS_UPDATE" -eq 1 ]]; then
  step "Stopping services before update"
  systemctl stop "${APP_NAME}" "${APP_NAME}-root-worker" 2>/dev/null || true
  SERVICES_STOPPED=1
  success "Application services stopped"
fi

# =============================================================================
# SOURCE MODE — pnpm install, Go build, TypeScript build
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then

  step "Installing pnpm dependencies"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile"
  success "Dependencies installed"

  step "Building root-worker"
  (
    cd "$APP_DIR/apps/root-worker"
    CGO_ENABLED=0 go build -ldflags="-s -w" -o "${APP_NAME}-root-worker" .
  )
  install -m 755 "$APP_DIR/apps/root-worker/${APP_NAME}-root-worker" /usr/local/bin/${APP_NAME}-root-worker
  success "Installed: /usr/local/bin/${APP_NAME}-root-worker"

  step "Building backend"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pnpm --filter @app/backend build"
  success "Backend bundled → apps/backend/dist/server.js"

  step "Building dashboard"
  if [[ "$SKIP_NGINX" != "1" ]] && command -v nginx &>/dev/null; then
    VITE_API_URL="/trpc"
  else
    SERVER_IP=$(hostname -I | awk '{print $1}')
    VITE_API_URL="http://${SERVER_IP}:${BACKEND_PORT}/trpc"
    warn "nginx not found — dashboard will connect directly to :${BACKEND_PORT}"
  fi
  printf 'VITE_API_URL=%s\n' "$VITE_API_URL" > "$APP_DIR/apps/dashboard/.env.production"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR/apps/dashboard' && pnpm build"
  success "Dashboard built → apps/dashboard/dist/"

  BACKEND_DIST="$APP_DIR/apps/backend/dist/server.js"
  DASHBOARD_DIST="$APP_DIR/apps/dashboard/dist"
  DB_WORK_DIR="$APP_DIR/packages/database"

# =============================================================================
# RELEASE MODE — download tarball, extract, install binaries
# =============================================================================
else

  step "Installing verified release"
  mkdir -p "$INSTALL_DIR"
  chown "$APP_USER:" "$INSTALL_DIR"
  # tar overwrites and adds files but NEVER removes ones deleted between
  # releases. A leftover schema file is fatal: Prisma loads every *.prisma in
  # the schema dir, so a stale model (e.g. role.prisma after the Roles→Groups
  # redesign) fails `prisma generate` with dangling type refs and aborts the
  # whole update. Wipe the release-owned code dirs first so the new set is
  # clean — the live DB (database/data) and secrets (.env) live outside these
  # paths and are preserved.
  ROLLBACK_REL_PATHS=(
    server.js public bin node_modules runtime scripts
    database/prisma database/src database/package.json
    package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE CHANGELOG.md README.md
  )
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    ROLLBACK_DIR="$INSTALL_DIR/.install-rollback-$$"
    mkdir -p "$ROLLBACK_DIR"
    for rel in "${ROLLBACK_REL_PATHS[@]}"; do
      if [[ -e "$INSTALL_DIR/$rel" || -L "$INSTALL_DIR/$rel" ]]; then
        mkdir -p "$ROLLBACK_DIR/$(dirname "$rel")"
        mv -- "$INSTALL_DIR/$rel" "$ROLLBACK_DIR/$rel"
      fi
    done
    if [[ -f "/usr/local/bin/${APP_NAME}-root-worker" ]]; then
      cp -- "/usr/local/bin/${APP_NAME}-root-worker" "$ROLLBACK_DIR/system-root-worker"
    fi
  fi
  cp -a "$RELEASE_STAGE/." "$INSTALL_DIR/"
  chown -R "$APP_USER:" \
    "$INSTALL_DIR/bin" \
    "$INSTALL_DIR/public" \
    "$INSTALL_DIR/database/prisma" \
    "$INSTALL_DIR/database/src" \
    "$INSTALL_DIR/database/package.json" \
    "$INSTALL_DIR/node_modules" \
    "$INSTALL_DIR/server.js" \
    "$INSTALL_DIR/package.json" \
    "$INSTALL_DIR/pnpm-lock.yaml" \
    "$INSTALL_DIR/pnpm-workspace.yaml" \
    "$INSTALL_DIR/runtime" \
    "$INSTALL_DIR/LICENSE" \
    "$INSTALL_DIR/CHANGELOG.md" \
    "$INSTALL_DIR/README.md"
  success "Extracted to $INSTALL_DIR"

  step "Installing root-worker binary"
  chmod +x "$INSTALL_DIR/bin/${RELEASE_APP_NAME}-root-worker"
  install -m 755 "$INSTALL_DIR/bin/${RELEASE_APP_NAME}-root-worker" /usr/local/bin/${APP_NAME}-root-worker
  success "Installed: /usr/local/bin/${APP_NAME}-root-worker"

  step "Checking bundled runtime dependencies"
  PRISMA_BIN="$INSTALL_DIR/node_modules/.bin/prisma"
  TSX_BIN="$INSTALL_DIR/node_modules/.bin/tsx"
  PRISMA_SCHEMA_ENGINE_BIN="$INSTALL_DIR/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x"
  PRISMA_QUERY_ENGINE_LIB="$INSTALL_DIR/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node"
  [[ -x "$PRISMA_BIN" && -x "$TSX_BIN" ]] \
    || die "Release archive is missing its locked runtime dependencies."
  success "Locked runtime dependencies found"

  step "Generating Prisma client"
  app_exec "
    cd '$INSTALL_DIR/database'
    NODE_PATH='$INSTALL_DIR/node_modules' \
      PRISMA_SCHEMA_ENGINE_BINARY='$PRISMA_SCHEMA_ENGINE_BIN' \
      PRISMA_QUERY_ENGINE_LIBRARY='$PRISMA_QUERY_ENGINE_LIB' \
      '$PRISMA_BIN' generate
  "
  success "Prisma client generated"

  BACKEND_DIST="$INSTALL_DIR/server.js"
  DASHBOARD_DIST="$INSTALL_DIR/public"
  DB_WORK_DIR="$INSTALL_DIR/database"

fi

# =============================================================================
# COMMON — database setup
# =============================================================================
step "Setting up database"
mkdir -p "$DB_DIR"
chown "$APP_USER:" "$DB_DIR"

if [[ "$IS_UPDATE" -eq 1 ]]; then
  BACKUP="$DB_DIR/${APP_NAME}.db.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DB_FILE" "$BACKUP"
  DB_ROLLBACK_FILE="$BACKUP"
  success "Database backed up → $BACKUP"
  ls -1t "$DB_DIR"/${APP_NAME}.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm --

  # ── Declarative container stacks ─────────────────────────────────────────────
  # The app user owns /opt/containers and writes compose.yaml files directly;
  # the root worker only runs docker compose. The compose data migration below
  # needs this dir to exist and be writable by the app user.
  step "Preparing /opt/containers"
  mkdir -p /opt/containers
  chown "$APP_USER" /opt/containers

  # ── Data migrations (idempotent) — MUST run BEFORE `db push` ────────────────
  # `db push --accept-data-loss` DROPS any table/column the new schema removed.
  # A migration that folds data out of a soon-to-be-dropped table (e.g. old
  # Role/Permission grants → UserPlacePermission) must therefore run against the
  # OLD shape, before the push — otherwise that data is gone. Each script self-
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
        sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && DATABASE_URL='file:$DB_FILE' pnpm exec tsx '$rel'"
      else
        app_exec "cd '$DB_WORK_DIR' && DATABASE_URL='file:$DB_FILE' NODE_PATH='$INSTALL_DIR/node_modules' '$TSX_BIN' '$rel'"
      fi
    done
    success "Data migrations applied"
  fi

  # --accept-data-loss is required for column-type changes (e.g. Int -> BigInt);
  # Prisma flags those as lossy even when SQLite preserves the values. The DB was
  # just backed up above, so this is safe — and without the flag such schema
  # changes silently fail on update, leaving the running DB stale.
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && pnpm exec prisma db push --accept-data-loss"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$INSTALL_DIR/node_modules' PRISMA_SCHEMA_ENGINE_BINARY='$PRISMA_SCHEMA_ENGINE_BIN' PRISMA_QUERY_ENGINE_LIBRARY='$PRISMA_QUERY_ENGINE_LIB' '$PRISMA_BIN' db push --accept-data-loss"
  fi
  success "Schema migrated (existing data preserved)"
else
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && pnpm exec prisma db push --accept-data-loss"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$INSTALL_DIR/node_modules' PRISMA_SCHEMA_ENGINE_BINARY='$PRISMA_SCHEMA_ENGINE_BIN' PRISMA_QUERY_ENGINE_LIBRARY='$PRISMA_QUERY_ENGINE_LIB' '$PRISMA_BIN' db push --accept-data-loss"
  fi
  success "Schema created"
fi

if [[ "${SKIP_SEED}" != "1" ]]; then
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && pnpm exec tsx prisma/seed.ts"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$INSTALL_DIR/node_modules' '$TSX_BIN' prisma/seed.ts"
  fi
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    success "Seed applied (new permissions/roles merged, existing data untouched)"
  else
    success "Database seeded (admin / admin)"
  fi
fi

# =============================================================================
# COMMON — generate JWT secret and backend .env
# =============================================================================
step "Generating secrets"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — keeping existing secrets"
else
  JWT_SECRET=$(openssl rand -hex 32)
  printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$JWT_SECRET" > "$ENV_FILE"
  chown "$APP_USER:" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  success "Generated JWT secret → $ENV_FILE"
fi

# =============================================================================
# COMMON — install NATS server binary
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
# COMMON — configure NATS (credentials, nats.conf, worker.env)
# =============================================================================
step "Configuring NATS"

APP_CONF_DIR="/etc/${APP_NAME}"
NATS_DATA_DIR="/var/lib/${APP_NAME}/nats"
NATS_CONF="$APP_CONF_DIR/nats.conf"
WORKER_ENV="$APP_CONF_DIR/worker.env"

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
  warn "NATS credentials already exist — reusing"
fi

# shellcheck source=/dev/null
source "$APP_CONF_DIR/.nats-credentials"

cat > "$NATS_CONF" <<EOF
# NATS configuration — generated by install.sh on $(date)
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
        publish:   [ "events.>", "_INBOX.>", "\$JS.>" ]
        subscribe: [ "root.>", "_INBOX.>", "\$JS.>" ]
      }
    }
  ]
}
EOF
chmod 640 "$NATS_CONF"
chown root:nats "$NATS_CONF"
success "NATS config → $NATS_CONF"

cat > "$WORKER_ENV" <<EOF
NATS_URL=nats://127.0.0.1:4222
NATS_USER=worker
NATS_PASS=$NATS_WORKER_PASS
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
# COMMON — install systemd services
# =============================================================================
step "Installing systemd services"

# Backend + worker write their stdout/stderr to files here instead of the
# systemd journal, so operators have plain log files to tail/ship.
LOG_DIR="/var/log/${APP_NAME}"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$LOG_DIR"

# Keep those files from growing unbounded. copytruncate because systemd holds
# the file open (StandardOutput=append:) — no service restart needed to rotate.
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

cat > /etc/systemd/system/${APP_NAME}-nats.service <<EOF
[Unit]
Description=${APP_NAME} NATS JetStream Server
After=network.target

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
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/${APP_NAME}-root-worker.service <<EOF
[Unit]
Description=${APP_NAME} Root Worker
After=network.target ${APP_NAME}-nats.service
Requires=${APP_NAME}-nats.service

[Service]
ExecStart=/usr/local/bin/${APP_NAME}-root-worker
User=root
EnvironmentFile=$WORKER_ENV
PrivateTmp=yes
NoNewPrivileges=no
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/root-worker.log
StandardError=append:$LOG_DIR/root-worker.log
SyslogIdentifier=${APP_NAME}-root-worker

[Install]
WantedBy=multi-user.target
EOF

if [[ "$FROM_SOURCE" -eq 1 ]]; then
  SOURCE_EXTRA="Environment=DASHBOARD_PATH=${DASHBOARD_DIST}"
else
  SOURCE_EXTRA="Environment=INSTALL_DIR=${INSTALL_DIR}"
fi

cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=${APP_NAME} Backend
Documentation=https://github.com/${REPO}
After=network.target ${APP_NAME}-nats.service ${APP_NAME}-root-worker.service
Requires=${APP_NAME}-nats.service ${APP_NAME}-root-worker.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
$SOURCE_EXTRA
Environment=BACKEND_PORT=$BACKEND_PORT
ExecStart=$NODE_BIN $BACKEND_DIST
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/app.log
SyslogIdentifier=${APP_NAME}

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DB_DIR $APP_DIR /tmp $LOG_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}-nats" "${APP_NAME}-root-worker" "${APP_NAME}"
systemctl restart "${APP_NAME}-nats"
systemctl restart "${APP_NAME}-root-worker"
systemctl restart "${APP_NAME}"
SERVICES_STOPPED=0
CORE_INSTALL_COMPLETE=1
DB_ROLLBACK_FILE=""
if [[ -n "$ROLLBACK_DIR" && -d "$ROLLBACK_DIR" ]]; then
  rm -rf -- "$ROLLBACK_DIR"
  ROLLBACK_DIR=""
fi
success "All services started"

# =============================================================================
# RELEASE MODE — install update checker (systemd timer + path unit)
# =============================================================================
if [[ "$FROM_SOURCE" -eq 0 ]]; then
  step "Installing update checker"

  cat > /usr/local/bin/${APP_NAME}-check-update <<CHECKEOF
#!/usr/bin/env bash
REPO="${REPO}"
INSTALL_DIR="\${INSTALL_DIR:-${INSTALL_DIR}}"
latest=\$(curl -fsSL --max-time 15 \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/repos/\${REPO}/releases/latest" \\
  | grep -oP '"tag_name":\s*"\K[^"]+' || true)
[[ -n "\$latest" ]] || exit 0
printf '{"latestVersion":"%s","checkedAt":"%s"}\n' \\
  "\$latest" "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
  > "\$INSTALL_DIR/.update-check.json"
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

  cat > /etc/systemd/system/${APP_NAME}-update-apply.service << EOF
[Unit]
Description=Apply pending ${APP_NAME} update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Environment=APP_NAME=${APP_NAME}
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=APP_USER=${APP_USER}
Environment=BACKEND_PORT=${BACKEND_PORT}
Environment=NATS_SERVER_VERSION=${NATS_SERVER_VERSION}
Environment=SKIP_NGINX=${SKIP_NGINX}
Environment=SKIP_SEED=${SKIP_SEED}
ExecStart=:/bin/bash -c 'set -e; v=\$(cat "${DB_DIR}/.pending-update"); tmp=\$(mktemp); trap "rm -f \$tmp" EXIT; curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh -o \$tmp; VERSION=\$v bash \$tmp; rm -f "${DB_DIR}/.pending-update"'
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

  echo "$VERSION" > "$INSTALL_DIR/VERSION"
  chown "$APP_USER:" "$INSTALL_DIR/VERSION"
  success "Version recorded → $INSTALL_DIR/VERSION"
fi

# =============================================================================
# SOURCE MODE — record version from package.json
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  PKG_VERSION=$(node -e "process.stdout.write(require('$APP_DIR/package.json').version)" 2>/dev/null || echo "0.0.0")
  echo "v${PKG_VERSION}" > "$APP_DIR/VERSION"
  chown "$APP_USER:" "$APP_DIR/VERSION"
  success "Version recorded → $APP_DIR/VERSION"
fi

cleanup_legacy_app_units

# =============================================================================
# COMMON — nginx reverse proxy (optional)
# =============================================================================
if [[ "$SKIP_NGINX" != "1" ]] && command -v nginx &>/dev/null; then
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

    location / {
        root $DASHBOARD_DIST;
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

  SITES_ENABLED="/etc/nginx/sites-enabled"
  if [[ -d "$SITES_ENABLED" ]]; then
    rm -f "$SITES_ENABLED/${APP_NAME}"
    ln -s "$NGINX_CONF" "$SITES_ENABLED/${APP_NAME}"
  fi

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
if [[ "$SKIP_NGINX" != "1" ]] && command -v nginx &>/dev/null; then
  echo -e "  ${BOLD}Access:${NC}  http://$SERVER_IP"
else
  echo -e "  ${BOLD}Access:${NC}  http://$SERVER_IP:$BACKEND_PORT"
fi

echo ""
if [[ "$IS_UPDATE" -eq 0 ]]; then
  echo -e "  ${BOLD}Default login:${NC}  admin / admin"
  echo -e "  ${YELLOW}!! You'll be required to change this password on first login !!${NC}"
  echo ""
fi

echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    systemctl status ${APP_NAME}               # backend"
echo -e "    systemctl status ${APP_NAME}-root-worker   # privilege worker"
echo -e "    systemctl status ${APP_NAME}-nats          # message bus"
echo -e "    tail -f ${LOG_DIR}/app.log               # backend logs"
echo -e "    tail -f ${LOG_DIR}/root-worker.log       # worker logs"
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  echo -e "    sudo $0 --from-source        # re-run to update"
else
  echo -e "    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sudo bash"
fi
echo ""

if [[ "$LEGACY_MIGRATED" -eq 1 ]]; then
  echo ""
  echo -e "  ${YELLOW}Migrated legacy 'app' install -> 'hsi'${NC} (log: $MIGRATE_LOG)"
fi
