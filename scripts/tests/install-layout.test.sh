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
for f in is_flat_install convert_flat_install link_flat_paths install_release_dir check_data_paths worker_update prepare_log_dir code_tree_trusted quarantine_untrusted_releases recover_interrupted_update prepare_app_home take_install_root current_release_is resolve_installed; do
  grep -q "^$f()" "$TMP/func.sh" || { echo "FAIL $f not found in scripts/install.sh"; exit 1; }
done
# shellcheck disable=SC1091
source "$TMP/func.sh"
CODE_UID=$(id -u)
umask 022
UPDATE_STATE="$TMP/upd-state"; mkdir -m 700 "$UPDATE_STATE"

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
( INSTALL_DIR="$ALT"; DB_DIR="$ALT/database/data"; OLD_VERSION=""
  convert_flat_install && [[ "$OLD_VERSION" == v0.0.0-flat && -f "$ALT/releases/v0.0.0-flat/server.js" ]] ); rc=$?
check "flat install without VERSION becomes v0.0.0-flat" '[[ $rc -eq 0 ]]'
check "the app-owned worker copy is not kept as the release's worker" 'cmp -s "$SYSTEM_WORKER" "$ALT/releases/v0.0.0-flat/bin/hsi-worker"''

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
rm -f "$UPDATE_STATE/conversion"   # that failed conversion was another install's

# A real folder planted at current.tmp (the name the conversion links through) never
# becomes current: quarantine moves it aside, and the conversion refuses it anyway.
C1D="$TMP/c1d"
plant_flat() { # <dir>: a flat v1.65.0 with an app-owned current.tmp/ and current.tmp-77/
  rm -rf "$1"; mkdir -p "$1/database/data" "$1/current.tmp/bin" "$1/current.tmp-77/bin"
  echo s > "$1/server.js"; echo v1.65.0 > "$1/VERSION"
  printf '#!/bin/sh\necho planted\n' > "$1/current.tmp/bin/hsi-worker"
  cp "$1/current.tmp/bin/hsi-worker" "$1/current.tmp-77/bin/hsi-worker"
}
plant_flat "$C1D"
( INSTALL_DIR="$C1D"; DB_DIR="$C1D/database/data"; OLD_VERSION=""; convert_flat_install ) >/dev/null 2>&1; rc=$?
check "the conversion refuses a folder at current.tmp" '[[ $rc -ne 0 && ! -d "$C1D/current/bin" ]] && ! { [[ -e "$C1D/current" && ! -L "$C1D/current" ]]; }'
rm -f "$UPDATE_STATE/conversion"   # that failed conversion was another install's
plant_flat "$C1D"
( INSTALL_DIR="$C1D"; quarantine_untrusted_releases ) >/dev/null 2>&1; rc=$?
check "quarantine moves current.tmp and current.tmp-<pid> aside" '[[ $rc -eq 0 && ! -e "$C1D/current.tmp" && ! -e "$C1D/current.tmp-77" ]] && compgen -G "$C1D/.untrusted-*/current.tmp" >/dev/null && compgen -G "$C1D/.untrusted-*/current.tmp-77" >/dev/null'
( INSTALL_DIR="$C1D"; DB_DIR="$C1D/database/data"; OLD_VERSION=""; convert_flat_install ) >/dev/null 2>&1; rc=$?
check "after quarantine current links to the converted release" '[[ $rc -eq 0 && -L "$C1D/current" && "$(readlink "$C1D/current")" == "$C1D/releases/v1.65.0" ]] && cmp -s "$SYSTEM_WORKER" "$C1D/current/bin/hsi-worker"'
mkdir -p "$C1D/releases/.staging-5/node_modules"; chmod 777 "$C1D/releases/.staging-5/node_modules"
mkdir -p "$C1D/releases/.staging-6"
( INSTALL_DIR="$C1D"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "an untrusted staging folder is moved aside, a trusted one left for removal" '[[ ! -e "$C1D/releases/.staging-5" && -d "$C1D/releases/.staging-6" ]] && compgen -G "$C1D/.untrusted-*/.staging-5" >/dev/null'
rm -rf "$C1D/releases/.staging-6"
rm -rf "$C1D/current"; rm -f "$C1D/current"; mkdir -p "$C1D/current/bin"
( INSTALL_DIR="$C1D"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "a current that is a real folder is moved aside" '[[ ! -e "$C1D/current" ]]'

# A conversion killed after its renames, before the tree was root's, is resumed. Its
# record lives in the root-only update state dir and names the install (path, inode,
# start); any mismatch stops the installer instead of trusting it.
C1E="$TMP/c1e"
CONV_STATE="$TMP/conv-state"; mkdir -m 700 "$CONV_STATE"
flat_c1e() {
  rm -rf "$C1E"; mkdir -p "$C1E/database/data" "$C1E/public" "$C1E/bin"
  echo s > "$C1E/server.js"; echo '<html>' > "$C1E/public/index.html"; echo v1.65.0 > "$C1E/VERSION"
  echo 'app-owned copy' > "$C1E/bin/hsi-worker"
}
interrupt_c1e() { # a conversion killed before root_owned, the tree left the app user's
  ( INSTALL_DIR="$C1E"; UPDATE_STATE="$CONV_STATE"; DB_DIR="$C1E/database/data"; root_owned() { return 1; }; convert_flat_install ) >/dev/null 2>&1
  chmod 777 "$C1E/releases/v1.65.0/public"
}
q_c1e() { ( INSTALL_DIR="$C1E"; UPDATE_STATE="$CONV_STATE"; IS_UPDATE=1; quarantine_untrusted_releases ) 2>&1; }
flat_c1e; interrupt_c1e
check "an interrupted conversion is recorded in the update state, not in INSTALL_DIR" '[[ -f "$CONV_STATE/conversion" && ! -e "$C1E/.converting" ]] && grep -qx "version=v1.65.0" "$CONV_STATE/conversion" && grep -qx "install_inode=$(stat -c %i "$C1E")" "$CONV_STATE/conversion"'
out="$(q_c1e)"; rc=$?
check "the interrupted conversion is not quarantined" '[[ $rc -eq 0 && -d "$C1E/releases/v1.65.0" ]] && ! compgen -G "$C1E/.untrusted-*" >/dev/null'
check "it is still a flat install to convert" 'INSTALL_DIR="$C1E" UPDATE_STATE="$CONV_STATE" is_flat_install'
echo 'planted' > "$C1E/releases/v1.65.0/bin/hsi-worker"   # the app user rewrites its worker meanwhile
( INSTALL_DIR="$C1E"; UPDATE_STATE="$CONV_STATE"; DB_DIR="$C1E/database/data"; root_owned() { chmod -R go-w,ug-s "$@"; }; OLD_VERSION=""
  convert_flat_install && [[ "$OLD_VERSION" == v1.65.0 ]] ) >/dev/null 2>&1; rc=$?
check "the conversion resumes and takes ownership" '[[ $rc -eq 0 && "$(readlink "$C1E/current")" == "$C1E/releases/v1.65.0" && -f "$C1E/current/public/index.html" && "$(stat -c %a "$C1E/releases/v1.65.0/public")" == 755 && ! -e "$CONV_STATE/conversion" ]]'
check "a resumed release runs the root worker, never the app-written one" 'cmp -s "$SYSTEM_WORKER" "$C1E/releases/v1.65.0/bin/hsi-worker"'
# Any record that does not match this install stops the installer.
for spoil in inode dir version future mode flatversion; do
  flat_c1e; interrupt_c1e
  case $spoil in
    inode) sed -i "s/^install_inode=.*/install_inode=1/" "$CONV_STATE/conversion" ;;
    dir) sed -i "s|^install_dir=.*|install_dir=/opt/other|" "$CONV_STATE/conversion" ;;
    version) sed -i "s/^version=.*/version=v1.64.0/" "$CONV_STATE/conversion" ;;
    future) sed -i "s/^started=.*/started=$(( $(date +%s) + 3600 ))/" "$CONV_STATE/conversion" ;;
    mode) chmod 666 "$CONV_STATE/conversion" ;;
    flatversion) echo v1.64.0 > "$C1E/VERSION" ;;
  esac
  out="$(q_c1e)"; rc=$?
  check "a conversion record with a wrong $spoil stops the installer" '[[ $rc -ne 0 && "$out" == *"DIE"*"conversion"* && -d "$C1E/releases/v1.65.0" && ! -L "$C1E/current" ]]'
  rm -f "$CONV_STATE/conversion"
done
flat_c1e; interrupt_c1e; chmod 755 "$CONV_STATE"
out="$(q_c1e)"; rc=$?
check "a record in a state dir others can read stops the installer" '[[ $rc -ne 0 && "$out" == *"DIE"* ]]'
chmod 700 "$CONV_STATE"; rm -f "$CONV_STATE/conversion"
# Without a record, an app-owned release is quarantined as before.
flat_c1e; interrupt_c1e; rm -f "$CONV_STATE/conversion"
q_c1e >/dev/null; rc=$?
check "an interrupted release without a record is quarantined" '[[ $rc -eq 0 && ! -e "$C1E/releases/v1.65.0" ]]'
# A planted .converting under INSTALL_DIR means nothing.
flat_c1e; interrupt_c1e; rm -f "$CONV_STATE/conversion"; echo v1.65.0 > "$C1E/.converting"
q_c1e >/dev/null
check "a marker under INSTALL_DIR is ignored" '[[ ! -e "$C1E/releases/v1.65.0" ]]'

# Before #9a the app user owned INSTALL_DIR and could plant current and releases/:
# whatever is not root's alone, or a current that does not lead to exactly one of
# the remaining releases, is moved aside before it is trusted.
C1B="$TMP/c1b"
mkdir -p "$C1B/database/data" "$C1B/releases/v1.66.0/bin" "$C1B/releases/v1.64.0/bin" "$C1B/releases/v1.63.0"
echo s > "$C1B/server.js"; echo v1.65.0 > "$C1B/VERSION"
printf '#!/bin/sh\n' > "$C1B/releases/v1.66.0/bin/hsi-worker"; chmod 775 "$C1B/releases/v1.66.0/bin/hsi-worker"
printf '#!/bin/sh\n' > "$C1B/releases/v1.64.0/bin/hsi-worker"; chmod 755 "$C1B/releases/v1.64.0/bin/hsi-worker"
for r in v1.64.0 v1.63.0; do   # complete releases: server.js, public/index.html, a worker
  mkdir -p "$C1B/releases/$r/bin" "$C1B/releases/$r/public"; echo s > "$C1B/releases/$r/server.js"; echo h > "$C1B/releases/$r/public/index.html"
  printf '#!/bin/sh\n' > "$C1B/releases/$r/bin/hsi-worker"; chmod 755 "$C1B/releases/$r/bin/hsi-worker"
done
ln -s "$TMP/c1a-victim" "$C1B/releases/v1.62.0"
ln -s "$C1B/releases/v1.66.0" "$C1B/current"
( INSTALL_DIR="$C1B"; quarantine_untrusted_releases ) >/dev/null 2>&1; rc=$?
check "quarantine runs" '[[ $rc -eq 0 ]]'
check "a group-writable release is moved aside" '[[ ! -e "$C1B/releases/v1.66.0" ]] && compgen -G "$C1B/.untrusted-*/v1.66.0" >/dev/null'
check "a release that is a link is moved aside, not followed" '[[ ! -L "$C1B/releases/v1.62.0" && -d "$TMP/c1a-victim" ]] && compgen -G "$C1B/.untrusted-*/v1.62.0" >/dev/null'
check "a current leading to a moved release is moved aside" '[[ ! -e "$C1B/current" && ! -L "$C1B/current" ]]'
check "trusted releases stay" '[[ -d "$C1B/releases/v1.64.0" && -d "$C1B/releases/v1.63.0" ]]'
check "with root-owned releases left it is a releases install, not a flat one" '! INSTALL_DIR="$C1B" is_flat_install'
ln -s "$C1B/releases/v1.64.0/../v1.63.0" "$C1B/current"
( INSTALL_DIR="$C1B"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "a current that is not exactly releases/<version> is moved aside" '[[ ! -L "$C1B/current" && -d "$C1B/releases/v1.63.0" ]]'
ln -s "$C1B/releases/v1.64.0" "$C1B/current"
( INSTALL_DIR="$C1B"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "a current leading to a trusted release stays" '[[ "$(readlink "$C1B/current")" == "$C1B/releases/v1.64.0" ]]'
( INSTALL_DIR="$C1B"; CODE_UID=$(( $(id -u) + 1 )); quarantine_untrusted_releases ) >/dev/null 2>&1
check "releases that are not root's are moved aside" '[[ ! -e "$C1B/releases/v1.64.0" && ! -L "$C1B/current" ]]'
check "with every planted release moved aside the flat install is converted next" 'INSTALL_DIR="$C1B" is_flat_install'

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
# What the app user left in node_modules must be root's and closed once prepared.
writable() { echo x > "$1/node_modules/w"; chmod 666 "$1/node_modules/w"; }
check "a release whose node_modules stays writable is refused" '! (install_release_dir writable) >/dev/null 2>&1 && [[ ! -e "$NEW/node_modules/w" ]] && ! compgen -G "$INSTALL_DIR/releases/.staging-*" >/dev/null'
foreign() { echo x > "$1/node_modules/f"; }
check "a release with entries that are not root's is refused" '! (CODE_UID=$(( $(id -u) + 1 )); install_release_dir foreign) >/dev/null 2>&1 && [[ ! -e "$NEW/node_modules/f" ]]'

# Reinstalling the live version (a repair) never removes it: the copy stays staged
# for `update replace`, which swaps it in at the switch.
echo live > "$NEW/marker"
STAGED_DIR=""
REPAIR=1 install_release_dir; rc=$?
check "a repair leaves the live release in place" '[[ $rc -eq 0 && "$(cat "$NEW/marker")" == live ]]'
check "a repair stages the copy aside" '[[ "$STAGED_DIR" == "$INSTALL_DIR/releases/.staging-"* && -f "$STAGED_DIR/server.js" && ! -e "$STAGED_DIR/marker" ]]'
rm -rf -- "$STAGED_DIR"
check "the installer repairs instead of snapshotting when the version is the installed one" 'grep -q "^    REPAIR=1$" "$ROOT/scripts/install.sh" && grep -q "replace \"\$VERSION\"" "$ROOT/scripts/install.sh" && ! grep -q "^  if \[\[ \"\$IS_UPDATE\" -eq 1 \]\]; then$" <(sed -n "/^  # The worker of the verified release/,/^  step \"Installing \$VERSION/p" "$ROOT/scripts/install.sh")'

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
# A folder or a FIFO in place of a log file is moved aside or removed, never written
# into: systemd needs a regular file there.
mkdir -p "$TMP/logtypes"; mkdir "$TMP/logtypes/app.log"; echo keep > "$TMP/logtypes/app.log/inner"
mkfifo "$TMP/logtypes/backup.log"
( prepare_log_dir "$TMP/logtypes" "$(id -gn)" ) >/dev/null 2>&1; rc=$?
check "a folder named like a log file is replaced by a log file" '[[ $rc -eq 0 && -f "$TMP/logtypes/app.log" && ! -L "$TMP/logtypes/app.log" ]]'
check "the folder is moved aside untouched" 'compgen -G "$TMP/logtypes/app.log.moved-*/inner" >/dev/null && [[ "$(cat "$TMP"/logtypes/app.log.moved-*/inner)" == keep && ! -e "$TMP/logtypes/app.log.moved-*/app.log" ]]'
check "a FIFO named like a log file is replaced by a log file" '[[ -f "$TMP/logtypes/backup.log" && ! -p "$TMP/logtypes/backup.log" ]]'
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

# An interrupted update found by the next installer run is rolled back, with a
# message on every failure, and only by a worker root can trust.
REC="$TMP/rec"
mkdir -p "$REC/state" "$REC/stage/bin" "$REC/opt/releases/v1.67.0/bin"
fake_worker() { # <path> <exit code>: records its run, rolls back like the real one
  printf '#!/bin/bash\necho "$0" >> "%s/ran"\n[[ "$2" == recover ]] || exit 0\nrm -f "%s/state/in-progress.json"\nprintf "{\\n  \\"status\\": \\"rolled-back\\"\\n}\\n" > "%s/state/last.json"\nexit %s\n' "$REC" "$REC" "$REC" "$2" > "$1"
  chmod 755 "$1"
}
recover_case() { # <worker exit code>: runs the recovery with no worker.env at all
  rm -f "$REC/ran" "$REC/state/last.json"
  printf '{\n  "from": "v1.66.0",\n  "to": "v1.67.0",\n  "step": "health"\n}\n' > "$REC/state/in-progress.json"
  ( set -e; UPDATE_STATE="$REC/state" INSTALL_DIR="$REC/opt" RELEASE_STAGE="$REC/stage" WORKER_ENV="$REC/missing.env" \
    NATS_CONF=x BACKUP_CONFIG=x APP_NAME=hsi RELEASE_APP_NAME=hsi CODE_UID=${1:-$CODE_UID}
    recover_interrupted_update ) > "$REC/out" 2>&1
}
fake_worker "$REC/stage/bin/hsi-worker" 0
fake_worker "$REC/opt/releases/v1.67.0/bin/hsi-worker" 0
recover_case; rc=$?
check "the recovery runs without worker.env" '[[ $rc -eq 0 && ! -f "$REC/state/in-progress.json" ]]'
check "the recovery uses the trusted worker of the release updated to" '[[ "$(cat "$REC/ran")" == "$REC/opt/releases/v1.67.0/bin/hsi-worker" ]]'
chmod 775 "$REC/opt/releases/v1.67.0/bin/hsi-worker"
recover_case
check "a writable release worker is not run; the verified one is" '[[ "$(cat "$REC/ran")" == "$REC/stage/bin/hsi-worker" ]]'
chmod 755 "$REC/opt/releases/v1.67.0/bin/hsi-worker"; chmod 777 "$REC/opt/releases"
recover_case
check "a release under a writable releases/ is not run" '[[ "$(cat "$REC/ran")" == "$REC/stage/bin/hsi-worker" ]]'
chmod 755 "$REC/opt/releases"
recover_case $(( $(id -u) + 1 ))
check "a release that is not root's is not run" '[[ "$(cat "$REC/ran")" == "$REC/stage/bin/hsi-worker" ]]'
printf '#!/bin/bash\nexit 1\n' > "$REC/opt/releases/v1.67.0/bin/hsi-worker"
recover_case; rc=$?
check "a failed recovery says so" '[[ $rc -ne 0 ]] && grep -q "could not be rolled back" "$REC/out"'

# Installs from before the app -> hsi rename keep HOME == INSTALL_DIR, which is root's
# now: the dot folders node, nvm and npm write to are created for the app user, and
# only once nothing in INSTALL_DIR can be swapped any more.
HOMEDIR="$TMP/legacy-home"
mkdir -p "$HOMEDIR/.nvm"; chmod 755 "$HOMEDIR"
( INSTALL_DIR="$HOMEDIR" APP_HOME="$HOMEDIR" APP_USER="$(id -un)"; prepare_app_home ) >/dev/null 2>&1; rc=$?
check "the dot folders are created in a legacy home" '[[ $rc -eq 0 && -d "$HOMEDIR/.npm" && -d "$HOMEDIR/.cache" && -d "$HOMEDIR/.config" && -d "$HOMEDIR/.local" && -d "$HOMEDIR/.nvm" ]]'
check "they belong to the app user" '[[ "$(stat -c %U "$HOMEDIR/.cache")" == "$(id -un)" ]]'
rmdir "$HOMEDIR/.npm"; ln -s "$TMP/c1a-victim" "$HOMEDIR/.npm"
out="$( ( INSTALL_DIR="$HOMEDIR" APP_HOME="$HOMEDIR" APP_USER="$(id -un)"; prepare_app_home ) 2>&1)"; rc=$?
check "a dot folder that is a link is refused, not followed" '[[ $rc -ne 0 && "$out" == *".npm"*"link"* && -L "$HOMEDIR/.npm" && -f "$TMP/c1a-victim/file" ]]'
rm "$HOMEDIR/.npm"; rmdir "$HOMEDIR/.cache"; chmod 775 "$HOMEDIR"
( INSTALL_DIR="$HOMEDIR" APP_HOME="$HOMEDIR" APP_USER="$(id -un)"; prepare_app_home ) >/dev/null 2>&1; rc=$?
check "nothing is done while INSTALL_DIR is still writable by others" '[[ $rc -eq 0 && ! -e "$HOMEDIR/.cache" ]]'
chmod 755 "$HOMEDIR"
( INSTALL_DIR="$TMP/elsewhere" APP_HOME="$HOMEDIR" APP_USER="$(id -un)"; prepare_app_home ) >/dev/null 2>&1
check "a home outside INSTALL_DIR is left alone" '[[ ! -e "$HOMEDIR/.cache" ]]'

# INSTALL_DIR was the app user's before #9a: releases/ and database/ are checked for
# links only once INSTALL_DIR is root's, before root changes their mode.
TIR="$TMP/tir"
mkdir -p "$TIR/opt" "$TMP/tir-victim"; chmod 700 "$TMP/tir-victim"
ln -s "$TMP/tir-victim" "$TIR/opt/releases"
out="$( ( INSTALL_DIR="$TIR/opt" APP_DIR="$TIR/opt" DB_DIR="$TIR/opt/database/data" DB_FILE="$TIR/opt/database/data/hsi.db" \
  ENV_FILE="$TIR/opt/.env" APP_HOME=/nonexistent APP_USER="$(id -un)" FROM_SOURCE=0; take_install_root ) 2>&1)"; rc=$?
check "a releases/ swapped for a link is refused" '[[ $rc -ne 0 && "$out" == *"releases"*"link"* ]]'
check "the link target keeps its mode" '[[ "$(stat -c %a "$TMP/tir-victim")" == 700 ]]'
rm "$TIR/opt/releases"
( INSTALL_DIR="$TIR/opt" APP_DIR="$TIR/opt" DB_DIR="$TIR/opt/database/data" DB_FILE="$TIR/opt/database/data/hsi.db" \
  ENV_FILE="$TIR/opt/.env" APP_HOME=/nonexistent APP_USER="$(id -un)" FROM_SOURCE=0; take_install_root ) >/dev/null 2>&1; rc=$?
check "a real install dir is prepared" '[[ $rc -eq 0 && -d "$TIR/opt/releases" && -d "$TIR/opt/database/data" && -d "$TIR/opt/data" ]]'

# Commands run as the app user never inherit the update lock (fd 9): an app process
# could keep the lock held, or append to the lock file.
sed -n '/^run_as() {/,/^}/p' "$ROOT/scripts/install.sh" > "$TMP/run_as.sh"
fd_seen="$( (
  source "$TMP/run_as.sh"
  runuser() { shift 3; "$@"; }   # runuser -u <user> -- cmd...: run cmd as is
  exec 9>>"$TMP/update.lock"
  run_as "$(id -un)" '[[ -e /proc/self/fd/9 ]] && echo open || echo closed'
) 2>&1)"
check "run_as children do not see the lock fd" '[[ "$fd_seen" == closed ]]'

# Every trust check fails closed: an error, a missing path or an odd type is untrusted.
FC="$TMP/failclosed"
mkdir -p "$FC/releases/v1.0.0/bin" "$FC/releases/v1.0.0/locked/deep"
printf '#!/bin/sh\n' > "$FC/releases/v1.0.0/bin/hsi-worker"; chmod 755 "$FC/releases/v1.0.0/bin/hsi-worker"
check "a readable trusted tree passes" 'INSTALL_DIR="$FC" trusted_release "$FC/releases/v1.0.0"'
chmod 000 "$FC/releases/v1.0.0/locked"
check "a tree find cannot read is untrusted" '! code_tree_trusted "$FC/releases/v1.0.0" 2>/dev/null'
check "a release find cannot read is untrusted" '! INSTALL_DIR="$FC" trusted_release "$FC/releases/v1.0.0" 2>/dev/null'
( INSTALL_DIR="$FC"; UPDATE_STATE="$TMP/upd-state"; quarantine_untrusted_releases ) >/dev/null 2>&1
check "quarantine moves a release it cannot read" '[[ ! -e "$FC/releases/v1.0.0" ]]'
chmod -R u+rwx "$FC"/.untrusted-* 2>/dev/null
check "a missing path is untrusted" '! code_tree_trusted "$FC/none" && ! trusted_worker "$FC/none" && ! INSTALL_DIR="$FC" trusted_release "$FC/none"'
mkfifo "$FC/fifo"
check "a FIFO is not a trusted worker" '! trusted_worker "$FC/fifo"'
ln -s /bin/sh "$FC/link"
check "a link is not a trusted worker" '! trusted_worker "$FC/link"'
check "a release reached through a link is untrusted" 'ln -s "$FC/releases" "$TMP/fc-rel" && ! INSTALL_DIR="$FC" trusted_release "$TMP/fc-rel/../releases"' 2>/dev/null
( INSTALL_DIR="$FC"; UPDATE_STATE="$TMP/no-such-state"; DB_DIR="$FC/database/data"; mkdir -p "$FC/database/data"; echo s > "$FC/server.js"; convert_flat_install ) >/dev/null 2>&1; rc=$?
check "a conversion that cannot record itself does not start" '[[ $rc -ne 0 && -f "$FC/server.js" ]]'

# Recorded versions are checked against what current resolves to at each use.
CR="$TMP/cr"
mkdir -p "$CR/releases/v1.0.0" "$CR/releases/v1.1.0"
ln -s "$CR/releases/v1.0.0" "$CR/current"
check "current resolves to the recorded version" 'INSTALL_DIR="$CR" current_release_is v1.0.0'
check "another version does not match" '! INSTALL_DIR="$CR" current_release_is v1.1.0'
rm "$CR/current"; ln -s "$CR/releases/v1.0.0/" "$CR/current"
check "a current that is not exactly releases/<version> does not match" '! INSTALL_DIR="$CR" current_release_is v1.0.0'
rm "$CR/current"; ln -s "$CR/releases/v9.0.0" "$CR/current"
check "a dangling current does not match" '! INSTALL_DIR="$CR" current_release_is v9.0.0'
rm "$CR/current"; ln -s "$CR/releases/v1.1.0" "$CR/current"; chmod 777 "$CR/releases/v1.1.0"
check "an untrusted release does not match" '! INSTALL_DIR="$CR" current_release_is v1.1.0'
rm "$CR/current"; mkdir "$CR/current"
check "a current that is a folder does not match" '! INSTALL_DIR="$CR" current_release_is v1.0.0'
# The release block uses it before each step that relies on the recorded version.
block="$(sed -n '/^# RELEASE MODE: keep the previous version/,/^# RELEASE MODE: install update checker/p' "$ROOT/scripts/install.sh")"
block_of() { sed -n '/^if \[\[ "\$FROM_SOURCE" -eq 0 \]\]; then$/,/^fi$/p' "$ROOT/scripts/install.sh"; }
check "OLD_VERSION is what current resolves to" 'grep -q "current_release_is \"\$OLD_VERSION\" ||" <<<"$block" && ! grep -q "\-d \"\$INSTALL_DIR/releases/\$OLD_VERSION\" \]\]" <<<"$block"'
check "current is re-checked before the snapshot" 'grep -B3 "SNAP=\$(worker_update" <<<"$block" | grep -q "current_release_is \"\$OLD_VERSION\""'
check "current is re-checked before the switch" 'grep -A3 "mark_update switch" "$ROOT/scripts/install.sh" | grep -q "current_release_is \"\$OLD_VERSION\""'
check "current is checked after the switch" 'grep -A2 "switch \"\$VERSION\" || die" "$ROOT/scripts/install.sh" | grep -q "current_release_is \"\$VERSION\""'
check "a repair is refused while an update is in progress" 'grep -A3 "^    REPAIR=1$" "$ROOT/scripts/install.sh" | grep -q "in-progress.json"'
check "a repair re-checks current before the replace" 'grep -B3 "replace \"\$VERSION\"" "$ROOT/scripts/install.sh" | grep -q "current_release_is \"\$VERSION\""'

# What a run updates from is decided from the releases layout, never from what the app
# user could write (the flat VERSION file), and never by turning a releases install
# into a flat one.
lay() { # <dir>: an install dir in the releases layout, worker linked through current
  rm -rf "$1"; mkdir -p "$1/database/data" "$1/releases" "$TMP/lay-usr"
  ln -sfn "$1/current/bin/hsi-worker" "$TMP/lay-usr/hsi-worker"
}
lay_release() { # <dir> <version>
  mkdir -p "$1/releases/$2/bin"; echo "worker $2" > "$1/releases/$2/bin/hsi-worker"; chmod 755 "$1/releases/$2/bin/hsi-worker"
  echo s > "$1/releases/$2/server.js"; echo "$2" > "$1/releases/$2/VERSION"
  mkdir -p "$1/releases/$2/public"; echo '<html>' > "$1/releases/$2/public/index.html"
}
resolve_in() { # <dir> <is update>: resolve_installed there, prints OLD REPAIR SAFE
  ( INSTALL_DIR="$1"; UPDATE_STATE="$TMP/lay-state"; DB_DIR="$1/database/data"; SYSTEM_WORKER="$TMP/lay-usr/hsi-worker"
    IS_UPDATE=$2; VERSION=v1.67.0; rm -rf "$UPDATE_STATE"; mkdir -m 700 "$UPDATE_STATE"
    quarantine_untrusted_releases && resolve_installed && echo "old=$OLD_VERSION repair=$REPAIR safe=$SAFE_UPDATE" ) 2>&1
}
LAY="$TMP/lay"
lay "$LAY"; lay_release "$LAY" v1.66.0
ln -s "$LAY/releases/v1.67.0" "$LAY/current"   # v1.67.0 removed: current dangles
ln -s "$LAY/current/server.js" "$LAY/server.js"
out="$(resolve_in "$LAY" 1)"
check "a dangling current is pointed at the remaining release" '[[ "$out" == *"old=v1.66.0 repair=0 safe=1"* && "$(readlink "$LAY/current")" == "$LAY/releases/v1.66.0" ]]'
check "the dangling current is reported" '[[ "$out" == *WARN*current* ]]'
check "a releases install is never converted as flat" '[[ "$(cat "$LAY/releases/v1.66.0/bin/hsi-worker")" == "worker v1.66.0" && ! -e "$LAY/releases/v0.0.0-flat" ]]'
lay "$LAY"; lay_release "$LAY" v1.65.0; lay_release "$LAY" v1.66.2; lay_release "$LAY" v1.66.10
ln -s "$LAY/releases/v1.67.0" "$LAY/current"
out="$(resolve_in "$LAY" 1)"
check "with several releases the newest is chosen" '[[ "$out" == *"old=v1.66.10 "* && "$(readlink "$LAY/current")" == "$LAY/releases/v1.66.10" ]]'
lay "$LAY"; ln -s "$LAY/releases/v1.67.0" "$LAY/current"; echo '{}' > "$TMP/lay-last.json"
out="$( ( INSTALL_DIR="$LAY"; UPDATE_STATE="$TMP/lay-state"; DB_DIR="$LAY/database/data"; SYSTEM_WORKER="$TMP/lay-usr/hsi-worker"
  IS_UPDATE=1; VERSION=v1.67.0; rm -rf "$UPDATE_STATE"; mkdir -m 700 "$UPDATE_STATE"; cp "$TMP/lay-last.json" "$UPDATE_STATE/last.json"
  quarantine_untrusted_releases && resolve_installed && echo "old=$OLD_VERSION repair=$REPAIR safe=$SAFE_UPDATE" ) 2>&1)"
check "with no release left the run is a fresh install of the releases" '[[ "$out" == *"old= repair=0 safe=0"* && ! -e "$LAY/releases/v0.0.0-flat" && ! -L "$LAY/current" ]]'
# A run on the installed version of a releases install is a repair...
lay "$LAY"; lay_release "$LAY" v1.67.0; ln -s "$LAY/releases/v1.67.0" "$LAY/current"
out="$(resolve_in "$LAY" 1)"
check "current on the target version is a repair" '[[ "$out" == *"old=v1.67.0 repair=1 safe=0"* ]]'
# ...but a flat install whose VERSION file names the target is an update.
FV="$TMP/flatv"; rm -rf "$FV"; mkdir -p "$FV/database/data" "$FV/public"
echo s > "$FV/server.js"; echo v1.67.0 > "$FV/VERSION"
out="$( ( INSTALL_DIR="$FV"; UPDATE_STATE="$TMP/lay-state"; DB_DIR="$FV/database/data"; IS_UPDATE=1; VERSION=v1.67.0
  rm -rf "$UPDATE_STATE"; mkdir -m 700 "$UPDATE_STATE"; quarantine_untrusted_releases && resolve_installed && echo "old=$OLD_VERSION repair=$REPAIR safe=$SAFE_UPDATE" ) 2>&1)"
check "a flat VERSION naming the target never makes a repair" '[[ "$out" == *"repair=0 safe=1"* && "$out" != *"old=v1.67.0 "* && ! -e "$FV/releases/v1.67.0" ]]'
check "that flat version is kept under its own name" '[[ "$out" == *"old=v1.67.0-flat "* && -f "$FV/releases/v1.67.0-flat/server.js" ]]'
# The conversion never removes a worker it cannot replace, nor converts an empty tree.
NW="$TMP/noworker"; rm -rf "$NW"; mkdir -p "$NW/database/data" "$NW/bin"; echo s > "$NW/server.js"; echo 'app copy' > "$NW/bin/hsi-worker"
( INSTALL_DIR="$NW"; DB_DIR="$NW/database/data"; SYSTEM_WORKER="$TMP/lay-usr/hsi-worker"; convert_flat_install ) >/dev/null 2>&1; rc=$?
check "no conversion without a real root worker to keep" '[[ $rc -ne 0 && -f "$NW/server.js" && "$(cat "$NW/bin/hsi-worker")" == "app copy" && ! -e "$NW/releases" ]]'
rm -f "$UPDATE_STATE/conversion"
EMPTY="$TMP/emptytree"; rm -rf "$EMPTY"; mkdir -p "$EMPTY/database/data"
( INSTALL_DIR="$EMPTY"; DB_DIR="$EMPTY/database/data"; convert_flat_install ) >/dev/null 2>&1; rc=$?
check "an empty tree is never converted into v0.0.0-flat" '[[ $rc -ne 0 && ! -e "$EMPTY/releases/v0.0.0-flat" ]]'
rm -f "$UPDATE_STATE/conversion"
# The record is written only once the release folder exists; a record whose release
# never appeared (nothing moved yet) is stale and cleared.
# Behaviour: record_conversion runs once the release folder exists, and a failed
# record leaves no empty release behind.
SPY="$TMP/spy"; ORD="$TMP/order"; rm -rf "$ORD"; mkdir -p "$ORD/database/data"; echo s > "$ORD/server.js"; echo v1.65.0 > "$ORD/VERSION"
( INSTALL_DIR="$ORD"; DB_DIR="$ORD/database/data"
  record_conversion() { [[ -d "$INSTALL_DIR/releases/$1" ]] && echo exists > "$SPY" || echo missing > "$SPY"; return 1; }
  convert_flat_install ) >/dev/null 2>&1; rc=$?
check "the record is written once the release folder exists" '[[ "$(cat "$SPY")" == exists ]]'
check "a failed record leaves no empty release and the flat install whole" '[[ $rc -ne 0 && ! -e "$ORD/releases/v1.65.0" && -f "$ORD/server.js" ]]'
ST="$TMP/stale"; rm -rf "$ST" "$TMP/stale-state"; mkdir -p "$ST/database/data" "$ST/releases"; mkdir -m 700 "$TMP/stale-state"
echo s > "$ST/server.js"; echo v1.65.0 > "$ST/VERSION"
printf 'version=v1.65.0\ninstall_dir=%s\ninstall_inode=%s\nstarted=%s\n' "$ST" "$(stat -c %i "$ST")" "$(date +%s)" > "$TMP/stale-state/conversion"; chmod 600 "$TMP/stale-state/conversion"
out="$( ( INSTALL_DIR="$ST"; UPDATE_STATE="$TMP/stale-state"; DB_DIR="$ST/database/data"; IS_UPDATE=1; VERSION=v1.67.0
  quarantine_untrusted_releases && resolve_installed && echo "old=$OLD_VERSION" ) 2>&1)"
check "a record from before the release folder existed is cleared and the conversion runs" '[[ "$out" == *"old=v1.65.0"* && ! -e "$TMP/stale-state/conversion" && "$(readlink "$ST/current")" == "$ST/releases/v1.65.0" ]]'
# The exemption for the recorded release holds only when this run converts.
NC="$TMP/notconv"; rm -rf "$NC" "$TMP/nc-state"; mkdir -p "$NC/database/data" "$NC/releases/v1.65.0"; chmod 777 "$NC/releases/v1.65.0"; mkdir -m 700 "$TMP/nc-state"
printf 'version=v1.65.0\ninstall_dir=%s\ninstall_inode=%s\nstarted=%s\n' "$NC" "$(stat -c %i "$NC")" "$(date +%s)" > "$TMP/nc-state/conversion"; chmod 600 "$TMP/nc-state/conversion"
out="$( ( INSTALL_DIR="$NC"; UPDATE_STATE="$TMP/nc-state"; IS_UPDATE=0; quarantine_untrusted_releases ) 2>&1)"; rc=$?
check "without an update to convert, the recorded release is quarantined and the record cleared" '[[ $rc -eq 0 && ! -e "$NC/releases/v1.65.0" && ! -e "$TMP/nc-state/conversion" && "$out" == *WARN*conversion* ]]'

# An empty or incomplete releases/v* (a run killed between its mkdir and its record)
# is no installed release: it never makes a releases layout, never becomes current,
# and is swept when no conversion is recorded. Reproduces scratchpad/e1/run.sh.
E1="$TMP/e1"; rm -rf "$E1" "$TMP/e1-state"; mkdir -m 700 "$TMP/e1-state"
mkdir -p "$E1/database/data" "$E1/bin" "$E1/public"; echo s > "$E1/server.js"; echo '<html>' > "$E1/public/index.html"; echo v1.65.0 > "$E1/VERSION"
mkdir -p "$E1/releases/v1.65.0/database"
out="$( ( INSTALL_DIR="$E1"; UPDATE_STATE="$TMP/e1-state"; DB_DIR="$E1/database/data"; IS_UPDATE=1; VERSION=v1.67.0
  quarantine_untrusted_releases && resolve_installed && echo "old=$OLD_VERSION repair=$REPAIR safe=$SAFE_UPDATE" ) 2>&1)"
check "an empty release left by a kill is swept, and the flat install converted" '[[ "$out" == *"old=v1.65.0 repair=0 safe=1"* && -f "$E1/releases/v1.65.0/server.js" && -f "$E1/current/public/index.html" && ! -e "$E1/server.js" ]]' 
check "the swept empty release went to quarantine" 'compgen -G "$E1/.untrusted-*/v1.65.0" >/dev/null'
check "an incomplete release makes no releases layout" 'mkdir -p "$TMP/e1b/releases/v1.0.0/bin" && ! INSTALL_DIR="$TMP/e1b" UPDATE_STATE="$TMP/e1-state" has_releases_layout'
mkdir -p "$TMP/e1b/releases/v1.0.0/public"; echo s > "$TMP/e1b/releases/v1.0.0/server.js"; echo h > "$TMP/e1b/releases/v1.0.0/public/index.html"
printf '#!/bin/sh\n' > "$TMP/e1b/releases/v1.0.0/bin/hsi-worker"; chmod 755 "$TMP/e1b/releases/v1.0.0/bin/hsi-worker"
check "a complete release makes a releases layout" 'INSTALL_DIR="$TMP/e1b" UPDATE_STATE="$TMP/e1-state" has_releases_layout'
chmod 775 "$TMP/e1b/releases/v1.0.0/bin/hsi-worker"
check "a release whose worker is not trusted is incomplete" '! INSTALL_DIR="$TMP/e1b" UPDATE_STATE="$TMP/e1-state" has_releases_layout'
# A flat VERSION equal to the target is recorded as <core>-flat, and still matches.
FL="$TMP/flatrec"; rm -rf "$FL" "$TMP/fl-state"; mkdir -m 700 "$TMP/fl-state"
mkdir -p "$FL/database/data" "$FL/public"; echo s > "$FL/server.js"; echo '<html>' > "$FL/public/index.html"; echo v1.67.0 > "$FL/VERSION"
( INSTALL_DIR="$FL"; UPDATE_STATE="$TMP/fl-state"; DB_DIR="$FL/database/data"; VERSION=v1.67.0
  mv() { if [[ "$*" == *"/VERSION "* ]]; then return 1; fi; command mv "$@"; }   # killed before VERSION moved
  convert_flat_install ) >/dev/null 2>&1
check "the record names <core>-flat while VERSION stays at the top" 'grep -qx "version=v1.67.0-flat" "$TMP/fl-state/conversion" && [[ -f "$FL/VERSION" ]]'
out="$( ( INSTALL_DIR="$FL"; UPDATE_STATE="$TMP/fl-state"; DB_DIR="$FL/database/data"; IS_UPDATE=1; VERSION=v1.67.0
  quarantine_untrusted_releases && resolve_installed && echo "old=$OLD_VERSION safe=$SAFE_UPDATE" ) 2>&1)"
check "a <core>-flat record matches a top VERSION of <core> and resumes" '[[ "$out" == *"old=v1.67.0-flat safe=1"* && "$(readlink "$FL/current")" == "$FL/releases/v1.67.0-flat" ]]'

# Run the installer's health gate with a healthy worker. The recording command
# must follow the health check on the repair path, regardless of intervening lines.
HEALTH_GATE="$TMP/health-gate.sh"
sed -n '/^  # Health gate:/,/^fi$/{ /^fi$/d; p; }' "$ROOT/scripts/install.sh" > "$HEALTH_GATE"
HEALTH_SPY="$TMP/health-spy"
( SAFE_UPDATE=0 REPAIR=1 VERSION=v1.67.0 NEW_WORKER=new-worker
  step() { :; }
  worker_update() { printf '%s\n' "$*" >> "$HEALTH_SPY"; }
  source "$HEALTH_GATE" ); rc=$?
check "a healthy repair records its result" '[[ $rc -eq 0 ]] && cmp -s "$HEALTH_SPY" <(printf "%s\n" "new-worker health v1.67.0 --timeout 120" "new-worker repaired v1.67.0")'

# A refused release changes nothing: it is downloaded and verified before the lock
# dir, the legacy migration, the user and nvm.
line_of() { grep -n -m1 -F -- "$1" "$ROOT/scripts/install.sh" | cut -d: -f1; }
verify_at=$(line_of 'step "Downloading and verifying $VERSION"')
for later in 'install -d -m 0700 "$UPDATE_STATE"' '  migrate_legacy_app_install' 'useradd -r -m' 'app_exec "nvm install'; do
  at=$(line_of "$later")
  check "the release is verified before: $later" '[[ -n "$verify_at" && -n "$at" && $verify_at -lt $at ]]'
done

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
# A repair of v1.67.0: staged aside, swapped in by the worker.
REPAIR=1 install_release_dir
echo repaired > "$STAGED_DIR/server.js"
worker_update "$TMP/hsi-worker" replace v1.67.0 "$(basename "$STAGED_DIR")"; rc=$?
check "the worker swaps the repaired copy in" '[[ $rc -eq 0 && "$(cat "$INSTALL_DIR/current/server.js")" == repaired && ! -e "$STAGED_DIR" ]]'

exit $FAILED
