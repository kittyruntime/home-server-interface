#!/usr/bin/env bash
# Usage: VM_DIR=<scratch> scripts/vm/suite.sh <fresh|update> <archive> <version>
#
#   fresh   install the built archive on a blank VM, add data, reboot, then
#           refuse a broken update and check the rollback kept everything
#   update  install the latest published release, add data, update to the
#           built archive, roll back to the published release, update again
#
# Each run uses a disposable VM (lib.sh). Exit status 0 means every check held.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
# shellcheck source=scripts/vm/lib.sh
source "$here/lib.sh"

scenario="${1:?scenario}"; archive="${2:?archive}"; version="v${3#v}"
REPO="kittyruntime/home-server-interface"
DB=/opt/hsi/database/data/hsi.db
trap 'vm_ssh "journalctl -u hsi-server -n 80 --no-pager" > "$VM_DIR/hsi-server.log" 2>&1 || true; vm_stop' EXIT

install_build() {
  log "Installing the built archive $version"
  vm_put "$archive" "/root/$(basename "$archive")"
  vm_put "$root/scripts/install.sh" /root/install.sh
  vm_ssh "VERSION=$version HSI_RELEASE_ARCHIVE=/root/$(basename "$archive") bash /root/install.sh" > "$VM_DIR/install-$version.log" 2>&1 \
    || { tail -40 "$VM_DIR/install-$version.log"; fail "install of $version failed"; }
}

# Health, version and services, as the installer's own gate sees them.
expect_running() {
  local want="$1" health
  health=$(vm_ssh 'for i in $(seq 1 90); do curl -sfk https://127.0.0.1/health && exit 0; sleep 2; done; exit 1') \
    || fail "health endpoint never answered (expected $want)"
  python3 -c 'import json,sys; h=json.loads(sys.argv[1]); assert h["status"]=="ok" and h["db"] and h["nats"], h; assert h["version"]==sys.argv[2], (h["version"], sys.argv[2])' "$health" "$want" \
    || fail "unexpected health: $health"
  vm_ssh 'systemctl is-active --quiet hsi-server hsi-worker hsi-nats' || fail "a service is not active"
  log "Running $want: $health"
}

# The migration ledger lists exactly the migrations shipped with $1's source.
expect_ledger() {
  local shipped
  shipped=$(cd "$root/packages/database/prisma/schema/migrations" && find . -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | paste -sd,)
  vm_ssh "python3 -c 'import sqlite3,sys; c=sqlite3.connect(\"file:$DB?mode=ro\",uri=True); got=\",\".join(r[0] for r in c.execute(\"select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by 1\")); assert got==sys.argv[1], (got, sys.argv[1])' '$shipped'" \
    || fail "migration ledger does not match the shipped migrations ($shipped)"
}

# Rows and files an administrator would have: they must survive everything.
add_data() {
  log "Adding a place, a group and files"
  vm_ssh "python3 - <<'PY'
import sqlite3
c = sqlite3.connect('$DB')
c.execute(\"INSERT INTO Place (id, name, path, createdAt, updatedAt) VALUES ('vm-place', 'VM test', '/srv/vm-test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)\")
c.execute(\"INSERT INTO \\\"Group\\\" (id, name, createdAt) VALUES ('vm-group', 'vm-testers', CURRENT_TIMESTAMP)\")
c.commit()
PY
mkdir -p /srv/vm-test/nested && for i in 1 2 3; do head -c 2M /dev/urandom > /srv/vm-test/nested/file\$i.bin; done
(cd /srv/vm-test && find . -type f -exec sha256sum {} + | sort > /root/vm-test.sha256)"
}

expect_data() {
  vm_ssh "python3 -c 'import sqlite3; c=sqlite3.connect(\"file:$DB?mode=ro\",uri=True); assert c.execute(\"select name, path from Place where id=\\\"vm-place\\\"\").fetchone()==(\"VM test\",\"/srv/vm-test\"); assert c.execute(\"select name from \\\"Group\\\" where id=\\\"vm-group\\\"\").fetchone()==(\"vm-testers\",)' && cd /srv/vm-test && find . -type f -exec sha256sum {} + | sort | cmp -s - /root/vm-test.sha256" \
    || fail "data added before was lost or changed"
  log "Data intact"
}

# A release whose server exits at once: the installer must roll back by itself.
broken_update() {
  local bad="v99.0.0" dir="$VM_DIR/broken"
  log "Installing a broken $bad: expecting an automatic rollback"
  rm -rf "$dir" && mkdir -p "$dir" && tar -xzf "$archive" -C "$dir"
  mv "$dir/hsi-$version" "$dir/hsi-$bad"
  echo 'process.exit(1)' > "$dir/hsi-$bad/server.js"
  tar -czf "$VM_DIR/hsi-$bad-linux-amd64.tar.gz" -C "$dir" "hsi-$bad"
  vm_put "$VM_DIR/hsi-$bad-linux-amd64.tar.gz" /root/
  if vm_ssh "VERSION=$bad HSI_RELEASE_ARCHIVE=/root/hsi-$bad-linux-amd64.tar.gz bash /root/install.sh" > "$VM_DIR/install-$bad.log" 2>&1; then
    fail "the broken release was accepted"
  fi
  grep -q 'Rolled back' "$VM_DIR/install-$bad.log" || { tail -30 "$VM_DIR/install-$bad.log"; fail "no rollback reported"; }
}

vm_boot
case "$scenario" in
  fresh)
    install_build
    expect_running "$version"; expect_ledger
    add_data
    vm_reboot
    expect_running "$version"; expect_data
    broken_update
    expect_running "$version"; expect_ledger; expect_data
    ;;
  update)
    published=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
    log "Installing the published $published"
    vm_ssh "curl -fsSL https://github.com/$REPO/releases/download/$published/install.sh -o /root/published-install.sh && VERSION=$published bash /root/published-install.sh" > "$VM_DIR/install-$published.log" 2>&1 \
      || { tail -40 "$VM_DIR/install-$published.log"; fail "install of $published failed"; }
    expect_running "$published"
    add_data
    install_build
    expect_running "$version"; expect_ledger; expect_data
    log "Rolling back to $published"
    vm_ssh "echo $published | hsi-worker update rollback" > "$VM_DIR/rollback.log" 2>&1 || { tail -30 "$VM_DIR/rollback.log"; fail "rollback failed"; }
    expect_running "$published"; expect_data
    install_build
    expect_running "$version"; expect_ledger; expect_data
    ;;
  *) fail "unknown scenario $scenario" ;;
esac
log "Scenario $scenario passed"
