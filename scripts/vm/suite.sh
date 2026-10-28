#!/usr/bin/env bash
# Usage: VM_DIR=<scratch> scripts/vm/suite.sh <fresh|update> <archive> <version>
#
#   fresh   install the built archive on a blank VM, add data, reboot, then
#           refuse a broken update and check the rollback kept everything
#   update  install the latest published release, add data, update to the
#           built archive, roll back to the published release, update again
#   storage create a mirrored volume through the API, check mdadm, LVM, the
#           mount, fstab, the Place and the share on the host, then reboot
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
  # A fresh install serves HTTPS on the backend port; older installs may use 443.
  health=$(vm_ssh 'for i in $(seq 1 90); do for p in 9001 443; do curl -sfk "https://127.0.0.1:$p/health" && exit 0; done; sleep 2; done; exit 1') \
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

# Calls the API as an administrator, from inside the VM (the health and API
# answer local callers). The session token is signed with the installation's
# JWT secret for an administrator row added for the test.
api_setup() {
  vm_ssh "python3 - <<'PY'
import base64, hashlib, hmac, json, sqlite3, time, uuid
c = sqlite3.connect('$DB')
c.execute(\"INSERT OR IGNORE INTO User (id, username, password, isAdmin, updatedAt) VALUES ('vm-admin', 'vmadmin', 'x', 1, CURRENT_TIMESTAMP)\")
c.commit()
secret = next(l.split('=', 1)[1].strip() for l in open('/opt/hsi/.env') if l.startswith('JWT_SECRET='))
b64 = lambda d: base64.urlsafe_b64encode(d).rstrip(b'=')
head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
body = b64(json.dumps({'userId': 'vm-admin', 'isAdmin': True, 'isUserManager': True, 'capabilities': [], 'mustChangePassword': False,
                       'jti': str(uuid.uuid4()), 'iat': int(time.time()), 'exp': int(time.time()) + 7200}).encode())
sig = b64(hmac.new(secret.encode(), head + b'.' + body, hashlib.sha256).digest())
open('/root/token', 'w').write((head + b'.' + body + b'.' + sig).decode())
PY"
}

# api <procedure> <json input>: the tRPC result data, or a failure.
api() {
  local out
  out=$(vm_ssh "curl -sk -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/json' --data-binary @- https://127.0.0.1:9001/trpc/$1" <<<"$2") \
    || fail "API $1 unreachable"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert "result" in r, r.get("error", r); print(json.dumps(r["result"]["data"]))' "$out" \
    || fail "API $1 failed: $out"
}

# The blank data disks, by the serial QEMU gives them.
data_disk() { vm_ssh "basename \$(readlink -f /dev/disk/by-id/virtio-HSI-DATA-$1)"; }

create_mirror() {
  local a b input plan fp result
  a=$(data_disk 1); b=$(data_disk 2)
  log "Creating a mirrored volume on $a and $b through the API"
  input="{\"disks\":[\"$a\",\"$b\"],\"redundancy\":\"raid1\",\"vg\":\"vmvg\",\"lv\":\"vmlv\",\"lvPercent\":100,\"label\":\"vmdata\",\"mountpoint\":\"/srv/vm-mirror\",\"access\":\"shared\"}"
  input="{\"volume\":$input,\"place\":{\"name\":\"Mirror\"},\"share\":{\"smbName\":\"mirror\"}}"
  plan=$(api storage.volumePlan "{\"input\":$input}")
  fp=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["fingerprint"])' "$plan")
  result=$(api storage.volumeApply "{\"input\":$input,\"fingerprint\":\"$fp\"}")
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["ok"], r' "$result" || fail "volume creation failed: $result"
}

expect_mirror() {
  vm_ssh 'set -e
    md=$(lsblk -nro NAME,TYPE | awk "\$2==\"raid1\"{print \$1; exit}")
    test -n "$md"
    mdadm --detail /dev/$md | grep -q "Raid Level : raid1"
    mdadm --detail /dev/$md | grep -Eq "Active Devices : 2"
    grep -q "^ARRAY " /etc/mdadm/mdadm.conf
    lvs --noheadings -o lv_name vmvg | grep -q vmlv
    findmnt -no FSTYPE /srv/vm-mirror | grep -q .
    grep -E "^UUID=[^ ]+ +/srv/vm-mirror " /etc/fstab | grep -q nofail
    touch /srv/vm-mirror/.write-test && rm /srv/vm-mirror/.write-test' \
    || fail "the mirrored volume is not as requested on the host"
  vm_ssh "python3 -c 'import sqlite3; c=sqlite3.connect(\"file:$DB?mode=ro\",uri=True); assert c.execute(\"select count(*) from Place where path=\\\"/srv/vm-mirror\\\"\").fetchone()[0]==1'" \
    || fail "no Place for the volume"
  if vm_ssh 'command -v smbd >/dev/null'; then
    vm_ssh 'testparm -s 2>/dev/null | grep -A3 "^\[mirror\]" | grep -q "path = /srv/vm-mirror"' || fail "no SMB share for the volume"
  fi
  log "Mirror, LVM, mount, fstab, Place and share in place"
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
  storage)
    install_build
    expect_running "$version"
    api_setup
    create_mirror
    expect_mirror
    vm_reboot
    expect_running "$version"; expect_mirror
    ;;
  *) fail "unknown scenario $scenario" ;;
esac
log "Scenario $scenario passed"
