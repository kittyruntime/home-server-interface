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
#   APP_NAME              App identifier             (default: app)
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

APP_NAME="${APP_NAME:-app}"
REPO="kittyruntime/home-server-interface"

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

# ── Must run as root ───────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0"

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

  id "$BACKEND_USER" &>/dev/null \
    || die "User '$BACKEND_USER' does not exist."

  step "Checking prerequisites"
  check_cmd() { command -v "$1" &>/dev/null || die "'$1' not found. $2"; success "$1 found"; }
  check_cmd node    "Install Node.js ≥ 18 from https://nodejs.org/"
  check_cmd pnpm    "Install pnpm: npm install -g pnpm"
  check_cmd go      "Install Go ≥ 1.21 from https://go.dev/dl/"
  check_cmd openssl "apt install openssl"
  check_cmd curl    "apt install curl"

  NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
  [[ "$NODE_MAJOR" -ge 18 ]] || die "Node.js 18+ required, found $(node --version)"
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

  step "Checking prerequisites"
  command -v curl    &>/dev/null || die "'curl' not found. apt install curl"
  command -v openssl &>/dev/null || die "'openssl' not found. apt install openssl"
  success "Prerequisites satisfied"

  step "Resolving release version"
  if [[ -z "$VERSION" ]]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep -oP '"tag_name":\s*"\K[^"]+')
    [[ -n "$VERSION" ]] || die "Could not fetch latest release from GitHub."
  fi
  APP_DIR="$INSTALL_DIR"
  TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/${APP_NAME}-${VERSION}-linux-amd64.tar.gz"

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
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
  success "Node: $NODE_BIN"

fi

# =============================================================================
# COMMON — detect fresh install vs update
# =============================================================================
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  DB_DIR="$APP_DIR/packages/database/data"
else
  DB_DIR="$APP_DIR/database/data"
fi
DB_FILE="$DB_DIR/${APP_NAME}.db"
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
    GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "${APP_NAME}-root-worker" .
  )
  install -m 755 "$APP_DIR/apps/root-worker/${APP_NAME}-root-worker" /usr/local/bin/${APP_NAME}-root-worker
  success "Installed: /usr/local/bin/${APP_NAME}-root-worker"

  step "Building backend"
  mkdir -p "$APP_DIR/apps/backend/dist"
  sudo -u "$APP_USER" bash -c "
    cd '$APP_DIR/apps/backend'
    pnpm dlx esbuild src/server.ts \
      --bundle --platform=node --target=node18 --format=esm \
      --outfile=dist/server.js \
      --external:@prisma/client --external:@prisma/engines --external:fsevents \
      --banner:js=\"import { createRequire } from 'module'; const require = createRequire(import.meta.url);\" \
      --log-level=warning
  "
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

  step "Downloading $VERSION"
  DL_DIR=$(mktemp -d)
  trap 'rm -rf "$DL_DIR"' EXIT

  TARBALL="$DL_DIR/${APP_NAME}.tar.gz"
  curl -fsSL --progress-bar "$TARBALL_URL" -o "$TARBALL" || die "Download failed: $TARBALL_URL"
  success "Downloaded"

  mkdir -p "$INSTALL_DIR"
  tar -xzf "$TARBALL" --strip-components=1 -C "$INSTALL_DIR"
  chown -R "$APP_USER:" "$INSTALL_DIR"
  success "Extracted to $INSTALL_DIR"

  step "Installing root-worker binary"
  chmod +x "$INSTALL_DIR/bin/${APP_NAME}-root-worker"
  install -m 755 "$INSTALL_DIR/bin/${APP_NAME}-root-worker" /usr/local/bin/${APP_NAME}-root-worker
  success "Installed: /usr/local/bin/${APP_NAME}-root-worker"

  step "Installing runtime dependencies"
  PRISMA_BIN="$INSTALL_DIR/node_modules/.bin/prisma"
  TSX_BIN="$INSTALL_DIR/node_modules/.bin/tsx"
  app_exec "
    '$NPM_BIN' install \
      --prefix '$INSTALL_DIR' \
      --no-save --no-fund --no-audit \
      @prisma/client@^6 prisma@^6 tsx@^4 bcryptjs@^2
  "
  success "Runtime dependencies installed"

  step "Generating Prisma client"
  app_exec "
    cd '$INSTALL_DIR/database'
    NODE_PATH='$INSTALL_DIR/node_modules' '$PRISMA_BIN' generate
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
  success "Database backed up → $BACKUP"
  ls -1t "$DB_DIR"/${APP_NAME}.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm --

  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && npx prisma db push"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$INSTALL_DIR/node_modules' '$PRISMA_BIN' db push"
  fi
  success "Schema migrated (existing data preserved)"
else
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && npx prisma db push --accept-data-loss"
  else
    app_exec "cd '$DB_WORK_DIR' && NODE_PATH='$INSTALL_DIR/node_modules' '$PRISMA_BIN' db push --accept-data-loss"
  fi
  success "Schema created"
fi

if [[ "${SKIP_SEED}" != "1" ]]; then
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    sudo -u "$APP_USER" bash -c "cd '$DB_WORK_DIR' && npx tsx prisma/seed.ts"
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
StandardOutput=journal
StandardError=journal
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
ExecStart=$NODE_BIN $BACKEND_DIST
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DB_DIR $APP_DIR /tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}-nats" "${APP_NAME}-root-worker" "${APP_NAME}"
systemctl restart "${APP_NAME}-nats"
systemctl restart "${APP_NAME}-root-worker"
systemctl restart "${APP_NAME}"
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
ExecStart=/bin/bash -c 'set -e; v=\$(cat ${INSTALL_DIR}/.pending-update); tmp=\$(mktemp); trap "rm -f \$tmp ${INSTALL_DIR}/.pending-update" EXIT; curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh -o \$tmp; VERSION=\$v bash \$tmp'
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}-update
EOF

  cat > /etc/systemd/system/${APP_NAME}-update-apply.path << EOF
[Unit]
Description=Watch for pending ${APP_NAME} update

[Path]
PathExists=${INSTALL_DIR}/.pending-update

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
    }

    location /files {
        proxy_pass              http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version      1.1;
        proxy_set_header        Host          \$host;
        proxy_set_header        X-Real-IP     \$remote_addr;
        client_max_body_size    100m;
        proxy_request_buffering off;
        proxy_read_timeout      300s;
    }

    location /health {
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
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
  echo -e "  ${YELLOW}!! Change the admin password immediately after first login !!${NC}"
  echo ""
fi

echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    systemctl status ${APP_NAME}               # backend"
echo -e "    systemctl status ${APP_NAME}-root-worker   # privilege worker"
echo -e "    systemctl status ${APP_NAME}-nats          # message bus"
echo -e "    journalctl -u ${APP_NAME} -f               # live logs"
if [[ "$FROM_SOURCE" -eq 1 ]]; then
  echo -e "    sudo $0 --from-source        # re-run to update"
else
  echo -e "    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sudo bash"
fi
echo ""
