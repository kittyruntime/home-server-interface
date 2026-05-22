#!/usr/bin/env bash
# =============================================================================
# Brume — Install / Update from GitHub Release
# =============================================================================
# Downloads the latest pre-built release from GitHub and installs Brume
# as a systemd service. Node.js is installed via nvm in the brume user space —
# no system-wide Node required.
#
# First install:
#   curl -fsSL https://raw.githubusercontent.com/kittyruntime/brume/main/scripts/install-release.sh | sudo bash
#
# Update (re-run the same command):
#   curl -fsSL https://raw.githubusercontent.com/kittyruntime/brume/main/scripts/install-release.sh | sudo bash
#
# Or pin a specific version:
#   curl -fsSL ... | sudo VERSION=v1.2.0 bash
#
# Environment overrides:
#   VERSION               Release tag to install (default: latest)
#   INSTALL_DIR           Installation directory  (default: /opt/brume)
#   BRUME_USER             System user to run as   (default: brume)
#   BACKEND_PORT          Backend API port        (default: 9001)
#   NATS_SERVER_VERSION   nats-server version     (default: v2.10.24)
#   SKIP_NGINX            Set to 1 to skip nginx  (default: 0)
#   SKIP_SEED             Set to 1 to skip seed entirely (default: 0)
# =============================================================================

set -euo pipefail

REPO="kittyruntime/brume"
INSTALL_DIR="${INSTALL_DIR:-/opt/brume}"
BRUME_USER="${BRUME_USER:-brume}"
BACKEND_PORT="${BACKEND_PORT:-9001}"
NATS_SERVER_VERSION="${NATS_SERVER_VERSION:-v2.10.24}"
SKIP_NGINX="${SKIP_NGINX:-0}"
SKIP_SEED="${SKIP_SEED:-0}"
NODE_VERSION="22"

# ── Colour helpers ──────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "  ${CYAN}··${NC}  $*"; }
success() { echo -e "  ${GREEN}✓${NC}   $*"; }
warn()    { echo -e "  ${YELLOW}!${NC}   $*"; }
die()     { echo -e "\n  ${RED}✗ error:${NC} $*\n" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▶ $*${NC}"; }
banner()  {
  echo -e "${BOLD}"
  echo "  ███╗   ██╗ █████╗ ███████╗██╗  ██╗"
  echo "  ████╗  ██║██╔══██╗██╔════╝╚██╗██╔╝"
  echo "  ██╔██╗ ██║███████║███████╗ ╚███╔╝ "
  echo "  ██║╚██╗██║██╔══██║╚════██║ ██╔██╗ "
  echo "  ██║ ╚████║██║  ██║███████║██╔╝ ██╗"
  echo "  ╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝"
  echo -e "${NC}"
  echo "  Install from Release — $(date '+%Y-%m-%d %H:%M')"
  echo ""
}

# ── Must run as root ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"

banner

# ── 1. Prerequisites ────────────────────────────────────────────────────────────
step "Checking prerequisites"

check_cmd() {
  local cmd="$1" hint="$2"
  command -v "$cmd" &>/dev/null || die "'$cmd' not found. $hint"
  success "$cmd: $(command -v "$cmd")"
}

check_cmd curl    "apt install curl"
check_cmd openssl "apt install openssl"
success "All prerequisites satisfied"

# ── 2. Resolve version ──────────────────────────────────────────────────────────
step "Resolving release version"

if [[ -z "${VERSION:-}" ]]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -oP '"tag_name":\s*"\K[^"]+')
  [[ -n "$VERSION" ]] || die "Could not fetch latest release from GitHub."
fi

TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/brume-${VERSION}-linux-amd64.tar.gz"

info "Version:      $VERSION"
info "Install dir:  $INSTALL_DIR"
info "Run as user:  $BRUME_USER"
info "Backend port: $BACKEND_PORT"

# ── 3. Detect fresh install vs update ──────────────────────────────────────────
DB_FILE="$INSTALL_DIR/database/data/brume.db"
if [[ -f "$DB_FILE" ]]; then
  IS_UPDATE=1
  warn "Existing installation detected at $INSTALL_DIR — performing update"
  warn "Database will NOT be re-seeded and will NOT lose data"
else
  IS_UPDATE=0
  info "Fresh installation"
fi

# ── 4. Create system user ───────────────────────────────────────────────────────
step "Setting up system user"

if id "$BRUME_USER" &>/dev/null; then
  success "User '$BRUME_USER' already exists"
else
  useradd -r -m -s /usr/sbin/nologin "$BRUME_USER"
  success "Created system user '$BRUME_USER'"
fi

BRUME_HOME=$(getent passwd "$BRUME_USER" | cut -d: -f6)
NVM_DIR="$BRUME_HOME/.nvm"

# ── Helper: run a command as brume with nvm loaded ──────────────────────────────
brume_exec() {
  sudo -u "$BRUME_USER" bash -c "
    export HOME='$BRUME_HOME'
    export NVM_DIR='$NVM_DIR'
    [[ -s '$NVM_DIR/nvm.sh' ]] && source '$NVM_DIR/nvm.sh'
    $*
  "
}

# ── 5. Install nvm + Node.js ────────────────────────────────────────────────────
step "Installing Node.js $NODE_VERSION via nvm"

if [[ -f "$NVM_DIR/nvm.sh" ]]; then
  warn "nvm already installed — skipping"
else
  sudo -u "$BRUME_USER" bash -c "
    export HOME='$BRUME_HOME'
    export NVM_DIR='$NVM_DIR'
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  "
  success "nvm installed"
fi

brume_exec "nvm install $NODE_VERSION && nvm alias default $NODE_VERSION"
NODE_BIN=$(brume_exec "nvm which $NODE_VERSION")
NPM_BIN="$(dirname "$NODE_BIN")/npm"
success "Node: $NODE_BIN"

# ── 6. Stop services before replacing files (update only) ──────────────────────
if [[ "$IS_UPDATE" -eq 1 ]]; then
  step "Stopping services before update"
  # Stop the app services; brume-nats can keep running (we don't touch its binary
  # unless a new nats-server version is requested — handled separately below).
  systemctl stop brume brume-root-worker 2>/dev/null || true
  success "Application services stopped"
fi

# ── 7. Download & extract release ───────────────────────────────────────────────
step "Downloading $VERSION"

DL_DIR=$(mktemp -d)
trap 'rm -rf "$DL_DIR"' EXIT

TARBALL="$DL_DIR/brume.tar.gz"
curl -fsSL --progress-bar "$TARBALL_URL" -o "$TARBALL" \
  || die "Download failed: $TARBALL_URL"
success "Downloaded"

mkdir -p "$INSTALL_DIR"
# Extract: replaces server.js, public/, database/prisma/, bin/ etc.
# Does NOT touch database/data/ (not in tarball) or .env (not in tarball).
tar -xzf "$TARBALL" --strip-components=1 -C "$INSTALL_DIR"
chown -R "$BRUME_USER:" "$INSTALL_DIR"
success "Extracted to $INSTALL_DIR"

# ── 8. Install brume-root-worker binary ─────────────────────────────────────────
chmod +x "$INSTALL_DIR/bin/brume-root-worker"
install -m 755 "$INSTALL_DIR/bin/brume-root-worker" /usr/local/bin/brume-root-worker
success "Installed: /usr/local/bin/brume-root-worker"

# ── 9. Install runtime dependencies (Prisma, tsx) ──────────────────────────────
step "Installing runtime dependencies"

brume_exec "
  '$NPM_BIN' install \
    --prefix '$INSTALL_DIR' \
    --no-save --no-fund --no-audit \
    @prisma/client@^6 prisma@^6 tsx@^4 bcryptjs@^2
"
success "Runtime dependencies installed"

# ── 10. Generate Prisma client ──────────────────────────────────────────────────
step "Generating Prisma client"

PRISMA_BIN="$INSTALL_DIR/node_modules/.bin/prisma"

brume_exec "
  cd '$INSTALL_DIR/database'
  NODE_PATH='$INSTALL_DIR/node_modules' '$PRISMA_BIN' generate
"
success "Prisma client generated"

# ── 11. Database setup ──────────────────────────────────────────────────────────
step "Setting up database"

DB_DIR="$INSTALL_DIR/database/data"
mkdir -p "$DB_DIR"
chown "$BRUME_USER:" "$DB_DIR"

TSX_BIN="$INSTALL_DIR/node_modules/.bin/tsx"

if [[ "$IS_UPDATE" -eq 1 ]]; then
  # Back up the database before touching the schema.
  BACKUP="$DB_DIR/brume.db.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DB_FILE" "$BACKUP"
  success "Database backed up → $BACKUP"

  # Rotate: keep only the 5 most recent backups.
  ls -1t "$DB_DIR"/brume.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm --

  # Apply schema changes. Without --accept-data-loss, Prisma refuses to run
  # destructive operations — manual intervention would be needed in that case.
  brume_exec "
    cd '$INSTALL_DIR/database'
    NODE_PATH='$INSTALL_DIR/node_modules' '$PRISMA_BIN' db push
  "
  success "Schema migrated (existing data preserved)"
else
  # Fresh install — no data to protect.
  brume_exec "
    cd '$INSTALL_DIR/database'
    NODE_PATH='$INSTALL_DIR/node_modules' '$PRISMA_BIN' db push --accept-data-loss
  "
  success "Schema created"
fi

# Seed runs on every install and update. The seed uses upserts: it adds new
# roles and permissions introduced in this version without touching existing
# users or their data. It also re-hashes any plaintext passwords left from
# older releases.
if [[ "${SKIP_SEED:-0}" != "1" ]]; then
  brume_exec "
    cd '$INSTALL_DIR/database'
    NODE_PATH='$INSTALL_DIR/node_modules' '$TSX_BIN' prisma/seed.ts
  "
  if [[ "$IS_UPDATE" -eq 1 ]]; then
    success "Seed applied (new permissions/roles merged, existing data untouched)"
  else
    success "Database seeded (admin / admin)"
  fi
fi

# ── 12. Generate secrets ─────────────────────────────────────────────────────────
step "Generating secrets"

ENV_FILE="$INSTALL_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  warn ".env already exists — keeping existing secrets"
else
  JWT_SECRET=$(openssl rand -hex 32)
  printf 'NODE_ENV=production\nJWT_SECRET=%s\n' "$JWT_SECRET" > "$ENV_FILE"
  chown "$BRUME_USER:" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  success "Generated JWT secret → $ENV_FILE"
fi

# ── 13. Install NATS server ─────────────────────────────────────────────────────
step "Installing NATS server ($NATS_SERVER_VERSION)"

if command -v nats-server &>/dev/null && \
   nats-server --version 2>/dev/null | grep -qF "${NATS_SERVER_VERSION#v}"; then
  success "nats-server $NATS_SERVER_VERSION already installed"
else
  NATS_TMP=$(mktemp -d)
  NATS_DL="https://github.com/nats-io/nats-server/releases/download/${NATS_SERVER_VERSION}/nats-server-${NATS_SERVER_VERSION}-linux-amd64.tar.gz"
  curl -fsSL --progress-bar "$NATS_DL" -o "$NATS_TMP/nats.tar.gz" \
    || { rm -rf "$NATS_TMP"; die "Failed to download nats-server from $NATS_DL"; }
  tar -xzf "$NATS_TMP/nats.tar.gz" -C "$NATS_TMP" --strip-components=1
  # Stop NATS before replacing its binary (running executable cannot be replaced on Linux).
  systemctl stop brume-nats 2>/dev/null || true
  install -m 755 "$NATS_TMP/nats-server" /usr/local/bin/nats-server
  rm -rf "$NATS_TMP"
  success "Installed: /usr/local/bin/nats-server"
fi

if ! id "nats" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin nats
  success "Created system user 'nats'"
fi

# ── 14. Configure NATS ──────────────────────────────────────────────────────────
step "Configuring NATS"

BRUME_CONF_DIR="/etc/brume"
NATS_DATA_DIR="/var/lib/brume/nats"
NATS_CONF="$BRUME_CONF_DIR/nats.conf"
WORKER_ENV="$BRUME_CONF_DIR/worker.env"

mkdir -p "$BRUME_CONF_DIR" "$NATS_DATA_DIR"
chown nats: "$NATS_DATA_DIR"

# Generate credentials once; on updates the existing credentials are reused so
# the worker and backend .env do not need manual rotation.
if [[ ! -f "$BRUME_CONF_DIR/.nats-credentials" ]]; then
  NATS_BACKEND_PASS=$(openssl rand -hex 32)
  NATS_WORKER_PASS=$(openssl rand -hex 32)
  printf 'NATS_BACKEND_PASS=%s\nNATS_WORKER_PASS=%s\n' \
    "$NATS_BACKEND_PASS" "$NATS_WORKER_PASS" \
    > "$BRUME_CONF_DIR/.nats-credentials"
  chmod 600 "$BRUME_CONF_DIR/.nats-credentials"
  success "Generated NATS credentials → $BRUME_CONF_DIR/.nats-credentials"
else
  warn "NATS credentials already exist — reusing"
fi

# shellcheck source=/dev/null
source "$BRUME_CONF_DIR/.nats-credentials"

cat > "$NATS_CONF" <<EOF
# Brume NATS configuration — generated by install-release.sh on $(date)
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
        publish:   [ "brume.root.>", "_INBOX.>", "\$JS.>" ]
        subscribe: [ "brume.events.>", "_INBOX.>", "\$JS.>" ]
      }
    }
    {
      user: "worker"
      password: "$NATS_WORKER_PASS"
      permissions: {
        publish:   [ "brume.events.>", "_INBOX.>", "\$JS.>" ]
        subscribe: [ "brume.root.>", "_INBOX.>", "\$JS.>" ]
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

# Keep backend .env in sync with NATS credentials (idempotent).
for VAR in NATS_URL NATS_USER NATS_PASS; do
  sed -i "/^${VAR}=/d" "$ENV_FILE"
done
cat >> "$ENV_FILE" <<EOF
NATS_URL=nats://127.0.0.1:4222
NATS_USER=backend
NATS_PASS=$NATS_BACKEND_PASS
EOF
success "Backend NATS credentials → $ENV_FILE"

cat > /etc/systemd/system/brume-nats.service <<EOF
[Unit]
Description=Brume NATS JetStream Server
After=network.target

[Service]
ExecStart=/usr/local/bin/nats-server --config $NATS_CONF
# Wait until port 4222 is accepting connections before systemd marks this
# service active.  This makes After=brume-nats.service a true readiness gate
# for the dependent brume and brume-root-worker units.
ExecStartPost=/bin/bash -c 'for i in \$(seq 1 30); do bash -c "echo >/dev/tcp/127.0.0.1/4222" 2>/dev/null && exit 0; sleep 1; done; exit 1'
User=nats
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=brume-nats

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable brume-nats
systemctl restart brume-nats
success "brume-nats service started"

# ── 15. Install worker service ──────────────────────────────────────────────────
step "Installing brume-root-worker service"

cat > /etc/systemd/system/brume-root-worker.service <<EOF
[Unit]
Description=Brume Root Worker
After=network.target brume-nats.service
Requires=brume-nats.service

[Service]
ExecStart=/usr/local/bin/brume-root-worker
User=root
EnvironmentFile=$WORKER_ENV
PrivateTmp=yes
NoNewPrivileges=no
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=brume-root-worker

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable brume-root-worker
systemctl restart brume-root-worker
success "brume-root-worker service started"

# ── 16. Systemd service (backend) ───────────────────────────────────────────────
step "Installing systemd service"

SERVICE_FILE="/etc/systemd/system/brume.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Brume Backend
Documentation=https://github.com/${REPO}
After=network.target brume-nats.service brume-root-worker.service
Requires=brume-nats.service brume-root-worker.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$BRUME_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=brume

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$INSTALL_DIR/database/data $BRUME_HOME /tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable brume
systemctl restart brume
success "Service installed and started"

# ── 17. nginx (optional) ────────────────────────────────────────────────────────
if [[ "$SKIP_NGINX" != "1" ]] && command -v nginx &>/dev/null; then
  step "Configuring nginx"

  DASHBOARD_DIST="$INSTALL_DIR/public"
  NGINX_CONF="/etc/nginx/sites-available/brume"

  cat > "$NGINX_CONF" <<EOF
# Brume — generated by install-release.sh on $(date)
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
    rm -f "$SITES_ENABLED/brume"
    ln -s "$NGINX_CONF" "$SITES_ENABLED/brume"
  fi

  if [[ -f "$SITES_ENABLED/default" ]]; then
    warn "Disabling nginx default site (conflicts on port 80)"
    rm -f "$SITES_ENABLED/default"
  fi

  nginx -t && systemctl reload nginx
  success "nginx configured → $NGINX_CONF"
fi

# ── Summary ──────────────────────────────────────────────────────────────────────
echo ""
if [[ "$IS_UPDATE" -eq 1 ]]; then
  echo -e "${BOLD}${GREEN}╔═══════════════════════════════════╗"
  echo -e "║   Brume updated successfully!     ║"
  echo -e "╚═══════════════════════════════════╝${NC}"
else
  echo -e "${BOLD}${GREEN}╔═══════════════════════════════════╗"
  echo -e "║   Brume installed successfully!   ║"
  echo -e "╚═══════════════════════════════════╝${NC}"
fi
echo ""

SERVER_IP=$(hostname -I | awk '{print $1}')

if [[ "$SKIP_NGINX" != "1" ]] && command -v nginx &>/dev/null; then
  echo -e "  ${BOLD}Access Brume:${NC}  http://$SERVER_IP"
else
  echo -e "  ${BOLD}Access Brume:${NC}  http://$SERVER_IP:$BACKEND_PORT"
fi

echo ""
echo -e "  ${BOLD}Version:${NC}        $VERSION"
echo -e "  ${BOLD}Node.js:${NC}        $NODE_BIN"

if [[ "$IS_UPDATE" -eq 0 ]]; then
  echo -e "  ${BOLD}Default login:${NC}  admin / admin"
  echo -e "  ${YELLOW}!! Change the admin password immediately after first login !!${NC}"
fi

echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    systemctl status brume               # backend"
echo -e "    systemctl status brume-root-worker   # privilege worker"
echo -e "    systemctl status brume-nats          # message bus"
echo -e "    journalctl -u brume -f               # live logs"
echo ""
echo -e "  ${BOLD}To update:${NC}"
echo -e "    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install-release.sh | sudo bash"
echo ""
