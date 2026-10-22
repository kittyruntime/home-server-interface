#!/usr/bin/env bash
# Tests the side-by-side layout of scripts/install.sh without root: a flat
# install in a temp tree is converted to releases/, a new release is installed
# next to it, and the snapshot the installer writes for the first update is read
# back by the worker (built from apps/root-worker) with `update status`.
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
for f in is_flat_install convert_flat_install link_flat_paths install_release_dir write_install_snapshot; do
  grep -q "^$f()" "$TMP/func.sh" || { echo "FAIL $f not found in scripts/install.sh"; exit 1; }
done
# shellcheck disable=SC1091
source "$TMP/func.sh"

APP_NAME=hsi
RELEASE_APP_NAME=hsi
INSTALL_DIR="$TMP/opt/hsi"
DB_DIR="$INSTALL_DIR/database/data"
DB_FILE="$DB_DIR/hsi.db"
SYSTEM_WORKER="$TMP/usr-local-bin/hsi-worker"

# A flat install as left by v1.65.0's installer.
mkdir -p "$INSTALL_DIR"/{bin,public,node_modules/.bin,runtime,scripts,compose/src,data/wallpapers} \
  "$INSTALL_DIR"/database/{prisma/schema,src,data} "$(dirname "$SYSTEM_WORKER")"
echo 'server' > "$INSTALL_DIR/server.js"
echo '<html>' > "$INSTALL_DIR/public/index.html"
echo 'app-owned copy' > "$INSTALL_DIR/bin/hsi-worker"
echo 'prisma' > "$INSTALL_DIR/node_modules/.bin/prisma"
echo 'lock' > "$INSTALL_DIR/runtime/package-lock.json"
echo 'install' > "$INSTALL_DIR/scripts/install.sh"
echo 'compose' > "$INSTALL_DIR/compose/src/index.ts"
echo 'schema' > "$INSTALL_DIR/database/prisma/schema/base.prisma"
echo 'src' > "$INSTALL_DIR/database/src/index.ts"
echo '{}' > "$INSTALL_DIR/database/package.json"
for f in package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE CHANGELOG.md README.md; do echo "$f" > "$INSTALL_DIR/$f"; done
echo 'v1.65.0' > "$INSTALL_DIR/VERSION"
echo 'JWT_SECRET=s' > "$INSTALL_DIR/.env"
echo 'db' > "$DB_FILE"
echo 'img' > "$INSTALL_DIR/data/wallpapers/a.jpg"
printf '#!/bin/sh\necho root worker\n' > "$SYSTEM_WORKER"; chmod 755 "$SYSTEM_WORKER"

check "flat install detected" 'is_flat_install'
OLD_VERSION=""
convert_flat_install; rc=$?
REL="$INSTALL_DIR/releases/v1.65.0"
check "conversion succeeds" '[[ $rc -eq 0 && "$OLD_VERSION" == v1.65.0 ]]'
check "code moved under releases/v1.65.0" '[[ -f "$REL/server.js" && -f "$REL/public/index.html" && -f "$REL/node_modules/.bin/prisma" && -f "$REL/database/prisma/schema/base.prisma" && -f "$REL/database/package.json" && -f "$REL/compose/src/index.ts" && -f "$REL/LICENSE" ]]'
check "VERSION moved with the code" '[[ "$(cat "$REL/VERSION")" == v1.65.0 ]]'
check "the release keeps the worker that ran as root" 'cmp -s "$SYSTEM_WORKER" "$REL/bin/hsi-worker"'
check "current points to v1.65.0" '[[ "$(readlink "$INSTALL_DIR/current")" == "$REL" ]]'
check ".env untouched" '[[ -f "$INSTALL_DIR/.env" && ! -L "$INSTALL_DIR/.env" && "$(cat "$INSTALL_DIR/.env")" == JWT_SECRET=s ]]'
check "database/data untouched" '[[ -d "$DB_DIR" && ! -L "$DB_DIR" && "$(cat "$DB_FILE")" == db ]]'
check "data untouched" '[[ -d "$INSTALL_DIR/data" && ! -L "$INSTALL_DIR/data" && -f "$INSTALL_DIR/data/wallpapers/a.jpg" ]]'
check "the release reaches the live database" '[[ "$(readlink "$REL/database/data")" == "$DB_DIR" && "$(cat "$REL/database/data/hsi.db")" == db ]]'
check "no longer flat" '! is_flat_install'

link_flat_paths
check "flat code paths link through current" '[[ -L "$INSTALL_DIR/server.js" && "$(cat "$INSTALL_DIR/server.js")" == server && -L "$INSTALL_DIR/database/prisma" && -f "$INSTALL_DIR/database/prisma/schema/base.prisma" ]]'
check "VERSION reads through current" '[[ -L "$INSTALL_DIR/VERSION" && "$(cat "$INSTALL_DIR/VERSION")" == v1.65.0 ]]'
check "links leave data alone" '[[ ! -L "$INSTALL_DIR/.env" && ! -L "$DB_DIR" && ! -L "$INSTALL_DIR/data" ]]'
link_flat_paths
check "linking again is harmless" '[[ "$(readlink "$INSTALL_DIR/server.js")" == "$INSTALL_DIR/current/server.js" ]]'

# A flat install without VERSION is named v0.0.0-flat.
ALT="$TMP/alt"
mkdir -p "$ALT/database/data"; echo s > "$ALT/server.js"
( INSTALL_DIR="$ALT"; DB_DIR="$ALT/database/data"; SYSTEM_WORKER="$TMP/none"; OLD_VERSION=""
  convert_flat_install && [[ "$OLD_VERSION" == v0.0.0-flat && -f "$ALT/releases/v0.0.0-flat/server.js" ]] ); rc=$?
check "flat install without VERSION becomes v0.0.0-flat" '[[ $rc -eq 0 ]]'

# The new release next to it.
VERSION=v1.67.0
RELEASE_STAGE="$TMP/stage"
mkdir -p "$RELEASE_STAGE"/{bin,database/prisma,compose/src,node_modules}
echo 'new server' > "$RELEASE_STAGE/server.js"
printf '#!/bin/sh\n' > "$RELEASE_STAGE/bin/hsi-worker"; chmod 755 "$RELEASE_STAGE/bin/hsi-worker"
install_release_dir; rc=$?
NEW="$INSTALL_DIR/releases/v1.67.0"
check "new release installed" '[[ $rc -eq 0 && "$(cat "$NEW/server.js")" == "new server" && -x "$NEW/bin/hsi-worker" ]]'
check "new release records its version" '[[ "$(cat "$NEW/VERSION")" == v1.67.0 ]]'
check "new release reaches the live database" '[[ "$(readlink "$NEW/database/data")" == "$DB_DIR" ]]'
check "new release links @app/compose" '[[ "$(readlink "$NEW/node_modules/@app/compose")" == ../../compose ]]'
check "installing leaves current alone" '[[ "$(readlink "$INSTALL_DIR/current")" == "$REL" ]]'
check "no staging dir is left" '! compgen -G "$INSTALL_DIR/releases/.staging-*" >/dev/null'

# The first update's snapshot, written by the installer, read by the worker.
SYSTEMD_DIR="$TMP/systemd"
APP_CONF_DIR="$TMP/etc/hsi"
WORKER_ENV="$APP_CONF_DIR/worker.env"
NATS_CONF="$APP_CONF_DIR/nats.conf"
BACKUP_CONFIG="$APP_CONF_DIR/backup.json"
ENV_FILE="$INSTALL_DIR/.env"
TLS_DIR="$TMP/tls"
UPDATE_STATE="$TMP/state"
mkdir -p "$SYSTEMD_DIR" "$APP_CONF_DIR" "$TLS_DIR"
echo '[Unit]' > "$SYSTEMD_DIR/hsi-server.service"
echo '[Unit]' > "$SYSTEMD_DIR/hsi.target"
echo '[Timer]' > "$SYSTEMD_DIR/hsi-backup@1.timer"
ln -s "$SYSTEMD_DIR/hsi-server.service" "$SYSTEMD_DIR/hsi.service"
echo '[Unit]' > "$SYSTEMD_DIR/other.service"
echo 'NATS_PASS=x' > "$WORKER_ENV"; chmod 600 "$WORKER_ENV"
echo 'conf' > "$NATS_CONF"
echo '{}' > "$TLS_DIR/tls.json"
echo 'db-wal' > "$DB_FILE-wal"
SNAP="$(write_install_snapshot v1.65.0 v1.67.0)"; rc=$?
check "installer snapshot written" '[[ $rc -eq 0 && "$SNAP" == "$UPDATE_STATE/v1.65.0-v1.67.0" && -f "$SNAP/manifest.json" ]]'
check "snapshot holds the database and its WAL" '[[ "$(cat "$SNAP/database/hsi.db")" == db && "$(cat "$SNAP/database/hsi.db-wal")" == db-wal ]]'
check "snapshot keeps a unit link as a link" 'compgen -G "$SNAP/files/*-hsi.service" >/dev/null && [[ -L "$(compgen -G "$SNAP/files/*-hsi.service")" ]]'
check "snapshot skips other prefixes" '! grep -q other.service "$SNAP/manifest.json"'
check "a missing file is listed as not existing" 'grep -q "\"src\": \"$BACKUP_CONFIG\"" "$SNAP/manifest.json" && grep -A3 "\"src\": \"$BACKUP_CONFIG\"" "$SNAP/manifest.json" | grep -q "\"existed\": false"'
check "modes are numbers (0600 is 384)" 'grep -A3 "\"src\": \"$WORKER_ENV\"" "$SNAP/manifest.json" | grep -q "\"mode\": 384"'

# Generated files the update depends on.
check "no unit fetches install.sh from main" '! grep -q "raw.githubusercontent.com/\${REPO}/main/scripts/install.sh -o" "$ROOT/scripts/install.sh"'
{
  echo 'set -u'
  sed -n '/^  cat > \/etc\/systemd\/system\/\${APP_NAME}-update-apply.service << EOF$/,/^EOF$/p' "$ROOT/scripts/install.sh" \
    | sed "s#/etc/systemd/system#$TMP/units#"
  sed -n '/^cat > "\$NATS_CONF" <<EOF$/,/^EOF$/p' "$ROOT/scripts/install.sh"
} > "$TMP/render.sh"
mkdir -p "$TMP/units"
( APP_NAME=hsi INSTALL_DIR=/opt/hsi APP_USER=hsi BACKEND_PORT=9001 NATS_SERVER_VERSION=v2.10.24 SKIP_NGINX=0 SKIP_SEED=0 \
  WORKER_ENV=/etc/hsi/worker.env DB_DIR=/opt/hsi/database/data SYSTEM_WORKER=/usr/local/bin/hsi-worker \
  NATS_CONF="$TMP/nats.conf" NATS_DATA_DIR=/var/lib/hsi/nats NATS_BACKEND_PASS=b NATS_WORKER_PASS=w \
  bash "$TMP/render.sh" ) 2>"$TMP/render.err"
check "update-apply unit and nats.conf render under set -u" '[[ ! -s "$TMP/render.err" && -f "$TMP/units/hsi-update-apply.service" && -f "$TMP/nats.conf" ]]'
# systemd turns $$ into $ before bash runs the command.
apply_cmd="$(sed -n 's/^ExecStart=//p' "$TMP/units/hsi-update-apply.service" | sed 's/\$\$/$/g')"
check "update-apply runs the worker on the pending version" '[[ "$apply_cmd" == *"exec /usr/local/bin/hsi-worker update apply \"\$v\""* ]]'
check "update-apply reads the worker settings" 'grep -qx "EnvironmentFile=/etc/hsi/worker.env" "$TMP/units/hsi-update-apply.service"'
mkdir -p "$TMP/pending"; printf 'v1.67.0' > "$TMP/pending/.pending-update"
fake_cmd="${apply_cmd//\/opt\/hsi\/database\/data/$TMP/pending}"
fake_cmd="${fake_cmd//exec \/usr\/local\/bin\/hsi-worker/echo}"
apply_out="$(eval "$fake_cmd")"
check "update-apply passes the marker version and removes the marker" '[[ "$apply_out" == "update apply v1.67.0" && ! -e "$TMP/pending/.pending-update" ]]'
check "the worker NATS user may ask root.health" 'grep -A5 "user: \"worker\"" "$TMP/nats.conf" | grep -q "publish: *\[ \"events.>\", \"root.health\","'

if ! command -v go >/dev/null; then
  echo "FAIL go is needed to build the worker for the manifest check"
  exit 1
fi
if ! (cd "$ROOT/apps/root-worker" && CGO_ENABLED=0 go build -o "$TMP/hsi-worker" .) 2>"$TMP/build.err"; then
  echo "FAIL could not build the worker"; cat "$TMP/build.err"; exit 1
fi
worker() {
  env HSI_INSTALL_DIR="$INSTALL_DIR" HSI_UPDATE_STATE="$UPDATE_STATE" HSI_UPDATE_DB="$DB_FILE" \
    HSI_SYSTEMD_DIR="$SYSTEMD_DIR" HSI_UNIT_PREFIX=hsi HSI_WORKER_ENV="$WORKER_ENV" HSI_NATS_CONF="$NATS_CONF" \
    HSI_BACKEND_ENV="$ENV_FILE" HSI_TLS_DIR="$TLS_DIR" HSI_BACKUP_CONFIG="$BACKUP_CONFIG" HSI_LOG_LEVEL=error \
    "$TMP/hsi-worker" update "$@"
}
worker switch v1.67.0; rc=$?
check "the worker switches current on this layout" '[[ $rc -eq 0 && "$(readlink "$INSTALL_DIR/current")" == "$NEW" ]]'
status="$(worker status 2>"$TMP/status.err")"; rc=$?
check "the worker reports v1.67.0 as current" '[[ $rc -eq 0 && "$status" == *"\"current\":\"v1.67.0\""* ]]'
check "the worker accepts the installer snapshot" '[[ "$status" == *"\"version\":\"v1.65.0\",\"snapshot\":\"$SNAP\""* ]]'

exit $FAILED
