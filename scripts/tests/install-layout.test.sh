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
for f in is_flat_install convert_flat_install link_flat_paths install_release_dir check_data_paths worker_update prepare_log_dir code_tree_trusted quarantine_untrusted_releases; do
  grep -q "^$f()" "$TMP/func.sh" || { echo "FAIL $f not found in scripts/install.sh"; exit 1; }
done
# shellcheck disable=SC1091
source "$TMP/func.sh"
CODE_UID=$(id -u)
umask 022

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

# A flat install without VERSION is named v0.0.0-flat. Without a worker in
# /usr/local/bin, the app-owned copy in bin/ does not become the release's worker.
ALT="$TMP/alt"
mkdir -p "$ALT/database/data" "$ALT/bin"; echo s > "$ALT/server.js"; echo 'app-owned copy' > "$ALT/bin/hsi-worker"
( INSTALL_DIR="$ALT"; DB_DIR="$ALT/database/data"; SYSTEM_WORKER="$TMP/none"; OLD_VERSION=""
  convert_flat_install && [[ "$OLD_VERSION" == v0.0.0-flat && -f "$ALT/releases/v0.0.0-flat/server.js" ]] ); rc=$?
check "flat install without VERSION becomes v0.0.0-flat" '[[ $rc -eq 0 ]]'
check "the app-owned worker copy is not kept as the release's worker" '[[ ! -e "$ALT/releases/v0.0.0-flat/bin/hsi-worker" ]]'

# The conversion never writes through a link the app user planted in its bin/:
# the moved tree is root's before the worker is copied in.
C1A="$TMP/c1a"
mkdir -p "$C1A/database/data" "$C1A/bin" "$TMP/c1a-victim"
echo s > "$C1A/server.js"; echo v1.65.0 > "$C1A/VERSION"
echo 'victim' > "$TMP/c1a-victim/file"
ln -s "$TMP/c1a-victim/file" "$C1A/bin/hsi-worker.tmp"
( INSTALL_DIR="$C1A"; DB_DIR="$C1A/database/data"; OLD_VERSION=""; convert_flat_install ); rc=$?
check "a planted bin/hsi-worker.tmp link is not written through" '[[ "$(cat "$TMP/c1a-victim/file")" == victim ]]'
check "the converted release's worker is a regular copy of the root worker" '[[ $rc -eq 0 && -f "$C1A/releases/v1.65.0/bin/hsi-worker" && ! -L "$C1A/releases/v1.65.0/bin/hsi-worker" ]] && cmp -s "$SYSTEM_WORKER" "$C1A/releases/v1.65.0/bin/hsi-worker"'
check "the converted release is trusted code" 'code_tree_trusted "$C1A/releases/v1.65.0"'
# A moved tree that is not entirely root's (CODE_UID stands for root) is refused.
C1C="$TMP/c1c"
mkdir -p "$C1C/database/data"; echo s > "$C1C/server.js"
( INSTALL_DIR="$C1C"; DB_DIR="$C1C/database/data"; OLD_VERSION=""; CODE_UID=$(( $(id -u) + 1 )); convert_flat_install ) >/dev/null 2>&1; rc=$?
check "a converted tree left with entries that are not root's is refused" '[[ $rc -ne 0 && ! -L "$C1C/current" ]]'

# Before #9a the app user owned INSTALL_DIR and could plant current and releases/:
# whatever is not root's alone, or a current that does not lead to exactly one of
# the remaining releases, is moved aside before it is trusted.
C1B="$TMP/c1b"
mkdir -p "$C1B/database/data" "$C1B/releases/v1.66.0/bin" "$C1B/releases/v1.64.0/bin" "$C1B/releases/v1.63.0"
echo s > "$C1B/server.js"; echo v1.65.0 > "$C1B/VERSION"
printf '#!/bin/sh\n' > "$C1B/releases/v1.66.0/bin/hsi-worker"; chmod 775 "$C1B/releases/v1.66.0/bin/hsi-worker"
printf '#!/bin/sh\n' > "$C1B/releases/v1.64.0/bin/hsi-worker"; chmod 755 "$C1B/releases/v1.64.0/bin/hsi-worker"
ln -s "$TMP/c1a-victim" "$C1B/releases/v1.62.0"
ln -s "$C1B/releases/v1.66.0" "$C1B/current"
( INSTALL_DIR="$C1B"; quarantine_untrusted_releases ) >/dev/null 2>&1; rc=$?
check "quarantine runs" '[[ $rc -eq 0 ]]'
check "a group-writable release is moved aside" '[[ ! -e "$C1B/releases/v1.66.0" ]] && compgen -G "$C1B/.untrusted-*/v1.66.0" >/dev/null'
check "a release that is a link is moved aside, not followed" '[[ ! -L "$C1B/releases/v1.62.0" && -d "$TMP/c1a-victim" ]] && compgen -G "$C1B/.untrusted-*/v1.62.0" >/dev/null'
check "a current leading to a moved release is moved aside" '[[ ! -e "$C1B/current" && ! -L "$C1B/current" ]]'
check "trusted releases stay" '[[ -d "$C1B/releases/v1.64.0" && -d "$C1B/releases/v1.63.0" ]]'
check "the flat install is converted next" 'INSTALL_DIR="$C1B" is_flat_install'
ln -s "$C1B/releases/v1.64.0/../v1.63.0" "$C1B/current"
( INSTALL_DIR="$C1B"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "a current that is not exactly releases/<version> is moved aside" '[[ ! -L "$C1B/current" && -d "$C1B/releases/v1.63.0" ]]'
ln -s "$C1B/releases/v1.64.0" "$C1B/current"
( INSTALL_DIR="$C1B"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "a current leading to a trusted release stays" '[[ "$(readlink "$C1B/current")" == "$C1B/releases/v1.64.0" ]]'
( INSTALL_DIR="$C1B"; CODE_UID=$(( $(id -u) + 1 )); quarantine_untrusted_releases ) >/dev/null 2>&1
check "releases that are not root's are moved aside" '[[ ! -e "$C1B/releases/v1.64.0" && ! -L "$C1B/current" ]]'

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

# install_release_dir runs its preparation step (the Prisma client, as the app user)
# on the staging copy, before the release gets its final name.
rm -rf "$NEW"
prepare() { PREPARED_IN=$1; [[ ! -e "$NEW" ]] && echo client > "$1/node_modules/generated"; }
PREPARED_IN=""
install_release_dir prepare; rc=$?
check "the preparation step runs on the staging copy" '[[ $rc -eq 0 && "$PREPARED_IN" == "$INSTALL_DIR/releases/.staging-"* && "$(cat "$NEW/node_modules/generated")" == client ]]'
echo kept > "$NEW/marker"
check "a failed preparation keeps the installed release" '! (install_release_dir false) && [[ "$(cat "$NEW/marker")" == kept ]] && ! compgen -G "$INSTALL_DIR/releases/.staging-*" >/dev/null'
install_release_dir

# Root never follows a link planted in a path the app user controls.
APP_DIR="$INSTALL_DIR"; ENV_FILE="$INSTALL_DIR/.env"; FROM_SOURCE=0
out="$( (check_data_paths) 2>&1)"; rc=$?
check "real data paths pass" '[[ $rc -eq 0 ]]'
for planted in "$DB_DIR" "$DB_FILE" "$DB_FILE-wal" "$ENV_FILE" "$INSTALL_DIR/data" "$INSTALL_DIR/database"; do
  mv "$planted" "$planted.real" 2>/dev/null || true
  ln -s /etc/passwd "$planted"
  out="$( (check_data_paths) 2>&1)"; rc=$?
  check "a link at ${planted#"$INSTALL_DIR"/} is refused" '[[ $rc -ne 0 && "$out" == *"$planted"*"symbolic link"* ]]'
  rm "$planted"
  mv "$planted.real" "$planted" 2>/dev/null || true
done

# The log dir is root's: systemd appends to its files as root, so a link or a
# hardlink planted by the app user is replaced, never followed.
LOGS="$TMP/var/log/hsi"
mkdir -p "$LOGS" "$TMP/victim"
echo secret > "$TMP/victim/target"
echo mine > "$TMP/victim/own"
ln -s "$TMP/victim/target" "$LOGS/app.log"
ln "$TMP/victim/own" "$LOGS/root-worker.log"
echo old > "$LOGS/backup.log"; chmod 666 "$LOGS/backup.log"
ln -s "$TMP/victim" "$LOGS/nested"
out="$( (prepare_log_dir "$LOGS" "$(id -gn)") 2>&1)"; rc=$?
check "log dir prepared" '[[ $rc -eq 0 && -d "$LOGS" && ! -L "$LOGS" && "$(stat -c %a "$LOGS")" == 755 ]]'
check "a planted log link is replaced by a file" '[[ ! -L "$LOGS/app.log" && -f "$LOGS/app.log" && ! -s "$LOGS/app.log" && "$(cat "$TMP/victim/target")" == secret ]]'
check "a planted hardlink is replaced" '[[ "$(stat -c %h "$TMP/victim/own")" == 1 && -f "$LOGS/root-worker.log" && ! -s "$LOGS/root-worker.log" ]]'
check "an existing log keeps its lines with mode 0640" '[[ "$(cat "$LOGS/backup.log")" == old && "$(stat -c %a "$LOGS/backup.log")" == 640 ]]'
check "new log files are 0640" '[[ "$(stat -c %a "$LOGS/app.log")" == 640 ]]'
check "other links in the log dir are removed" '[[ ! -e "$LOGS/nested" && ! -L "$LOGS/nested" && -d "$TMP/victim" ]]'
rm -rf "$LOGS"; ln -s "$TMP/victim" "$LOGS"
( prepare_log_dir "$LOGS" "$(id -gn)" ) >/dev/null 2>&1; rc=$?
check "a log dir that is a link is replaced by a real dir" '[[ $rc -eq 0 && -d "$LOGS" && ! -L "$LOGS" && -f "$TMP/victim/target" && ! -e "$TMP/victim/app.log" ]]'

{
  echo 'set -u'
  sed -n '/^cat > \/etc\/logrotate.d\/\${APP_NAME} <<ROTATE$/,/^ROTATE$/p' "$ROOT/scripts/install.sh" | sed "s#/etc/logrotate.d#$TMP#"
} > "$TMP/rotate.sh"
( APP_NAME=hsi LOG_DIR=/var/log/hsi APP_GROUP_NAME=hsi bash "$TMP/rotate.sh" ) 2>"$TMP/rotate.err"
check "logrotate stanza renders" '[[ ! -s "$TMP/rotate.err" && -f "$TMP/hsi" ]]'
check "logrotate rotates as root" 'grep -qx "  su root root" "$TMP/hsi"'
check "logrotate creates root files the app group reads" 'grep -qx "  create 0640 root hsi" "$TMP/hsi"'
check "the server cannot write the log dir" '! grep -q "^ReadWritePaths=.*\$LOG_DIR" "$ROOT/scripts/install.sh"'

# Ownership order in the release block: data paths are checked again once
# INSTALL_DIR/database is root's.
check "data paths re-checked after database becomes root's" 'awk "/chown -h root:root \"\\\$INSTALL_DIR\/releases\" \"\\\$INSTALL_DIR\/database\"/{f=1;next} f&&/check_data_paths/{ok=1;exit} f&&/chown -h \"\\\$APP_USER:\"/{exit} END{exit !ok}" "$ROOT/scripts/install.sh"'

# Versions and URLs the update relies on.
first_go=$(sed -n 's/^const firstHealthVersion = "\(v[0-9.]*\)"$/\1/p' "$ROOT/apps/root-worker/update_health.go")
first_sh=$(sed -n 's/^FIRST_SAFE_UPDATE_VERSION="\(v[0-9.]*\)"$/\1/p' "$ROOT/scripts/install.sh")
check "FIRST_SAFE_UPDATE_VERSION equals firstHealthVersion" '[[ -n "$first_go" && "$first_go" == "$first_sh" ]]'
check "nothing but comments in install.sh names a /main/ URL" '! grep -n "/main/" "$ROOT/scripts/install.sh" | grep -qv "^[0-9]*:#"'

# Generated files the update depends on.
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
apply_cmd="$(sed -n 's/^ExecStart=//p' "$TMP/units/hsi-update-apply.service")"
check "the update-apply unit names no /main/ URL" '! grep -q "/main/" "$TMP/units/hsi-update-apply.service"'
check "update-apply runs the worker, which reads the marker itself" '[[ "$apply_cmd" == "/usr/local/bin/hsi-worker update apply-pending" ]]'
check "update-apply names the marker of this install" 'grep -qx "Environment=HSI_PENDING_UPDATE=/opt/hsi/database/data/.pending-update" "$TMP/units/hsi-update-apply.service"'
check "update-apply reads the worker settings" 'grep -qx "EnvironmentFile=/etc/hsi/worker.env" "$TMP/units/hsi-update-apply.service"'
check "the worker NATS user may ask root.health" 'grep -A5 "user: \"worker\"" "$TMP/nats.conf" | grep -q "publish: *\[ \"events.>\", \"root.health\","'

if ! command -v go >/dev/null; then
  echo "FAIL go is needed to build the worker for the snapshot check"
  exit 1
fi
if ! (cd "$ROOT/apps/root-worker" && CGO_ENABLED=0 go build -o "$TMP/hsi-worker" .) 2>"$TMP/build.err"; then
  echo "FAIL could not build the worker"; cat "$TMP/build.err"; exit 1
fi
# The first update's snapshot is taken by the worker of the staged release, called
# the way the installer calls it, and read back by the same worker.
SYSTEMD_DIR="$TMP/systemd"
APP_CONF_DIR="$TMP/etc/hsi"
WORKER_ENV="$APP_CONF_DIR/worker.env"
NATS_CONF="$APP_CONF_DIR/nats.conf"
BACKUP_CONFIG="$APP_CONF_DIR/backup.json"
UPDATE_STATE="$TMP/state"
export HSI_SYSTEMD_DIR="$SYSTEMD_DIR" HSI_TLS_DIR="$TMP/tls" HSI_LOG_LEVEL=error
mkdir -p "$SYSTEMD_DIR" "$APP_CONF_DIR" "$HSI_TLS_DIR"
echo '[Unit]' > "$SYSTEMD_DIR/hsi-server.service"
echo '[Unit]' > "$SYSTEMD_DIR/hsi.target"
ln -s "$SYSTEMD_DIR/hsi-server.service" "$SYSTEMD_DIR/hsi.service"
echo '[Unit]' > "$SYSTEMD_DIR/other.service"
echo 'NATS_PASS=x' > "$WORKER_ENV"; chmod 600 "$WORKER_ENV"
echo 'conf' > "$NATS_CONF"
echo '{}' > "$HSI_TLS_DIR/tls.json"
echo 'db-wal' > "$DB_FILE-wal"
SNAP="$(worker_update "$TMP/hsi-worker" snapshot v1.65.0 v1.67.0 2>"$TMP/snap.err")"; rc=$?
check "the staged worker snapshots a pre-9a install" '[[ $rc -eq 0 && "$SNAP" == "$UPDATE_STATE/v1.65.0-v1.67.0" && -f "$SNAP/manifest.json" ]]'
check "snapshot holds the database and its WAL" '[[ "$(cat "$SNAP/database/hsi.db")" == db && "$(cat "$SNAP/database/hsi.db-wal")" == db-wal ]]'
check "snapshot lists the unit files and configuration" 'grep -q "hsi-server.service" "$SNAP/manifest.json" && grep -q "\"src\": \"$WORKER_ENV\"" "$SNAP/manifest.json" && ! grep -q other.service "$SNAP/manifest.json"'
worker_update "$TMP/hsi-worker" switch v1.67.0; rc=$?
check "the worker switches current on this layout" '[[ $rc -eq 0 && "$(readlink "$INSTALL_DIR/current")" == "$NEW" ]]'
status="$(worker_update "$TMP/hsi-worker" status 2>"$TMP/status.err")"; rc=$?
check "the worker reports v1.67.0 as current" '[[ $rc -eq 0 && "$status" == *"\"current\":\"v1.67.0\""* ]]'
check "the worker reads the snapshot back" '[[ "$status" == *"\"version\":\"v1.65.0\",\"snapshot\":\"$SNAP\""* ]]'

exit $FAILED
