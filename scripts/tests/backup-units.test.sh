#!/usr/bin/env bash
# Renders the backup unit templates from scripts/install.sh into a temp dir and
# checks names and commands. Runs under set -u like the installer.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
check() { if ! eval "$2"; then echo "FAIL $1"; FAILED=1; else echo "ok   $1"; fi; }

check "install.sh has no mangled \${APP_backup variable" '! grep -q "\${APP_backup" "$ROOT/scripts/install.sh"'

mkdir -p "$TMP/units"
{
  echo 'set -u'
  sed -n '/^cat > \/etc\/systemd\/system\/\${APP_NAME}-backup/,/^EOF$/p' "$ROOT/scripts/install.sh" \
    | sed "s#/etc/systemd/system#$TMP/units#"
} > "$TMP/render.sh"

check "both unit heredocs were extracted" '(( $(grep -c "^cat > " "$TMP/render.sh") == 2 ))'
APP_NAME=hsi WORKER_ENV=/etc/hsi/worker.env LOG_DIR=/var/log/hsi bash "$TMP/render.sh" 2>"$TMP/err"
check "rendering succeeds under set -u" '[[ ! -s "$TMP/err" ]]'
check "backup unit file exists" '[[ -f "$TMP/units/hsi-backup@.service" ]]'
check "backup-check unit file exists" '[[ -f "$TMP/units/hsi-backup-check@.service" ]]'
check "backup ExecStart" 'grep -qx "ExecStart=/usr/local/bin/hsi-worker backup run %i" "$TMP/units/hsi-backup@.service"'
check "backup-check ExecStart" 'grep -qx "ExecStart=/usr/local/bin/hsi-worker backup check %i" "$TMP/units/hsi-backup-check@.service"'
check "backup After uses the worker unit" 'grep -qx "After=network-online.target hsi-worker.service" "$TMP/units/hsi-backup@.service"'
check "backup unit waits for the app restart" 'grep -qx "TimeoutStopSec=120s" "$TMP/units/hsi-backup@.service"'
check "backup-check unit waits for a clean stop" 'grep -qx "TimeoutStopSec=120s" "$TMP/units/hsi-backup-check@.service"'
check "backup-check identifier" 'grep -qx "SyslogIdentifier=hsi-backup-check" "$TMP/units/hsi-backup-check@.service"'

exit $FAILED
