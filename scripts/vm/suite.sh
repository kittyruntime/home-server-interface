#!/usr/bin/env bash
# Usage: VM_DIR=<scratch> scripts/vm/suite.sh <scenario> <archive> <version>
#
#   fresh   install the built archive on a blank VM, add data, reboot, then
#           refuse a broken update and check the rollback kept everything
#   update  install the latest published release, add data, update to the
#           built archive, roll back to the published release, update again
#   storage create a mirrored volume through the API, check mdadm, LVM, the
#           mount, fstab, the Place and the share on the host, then reboot
#   network hand the network to NetworkManager, change the addressing through
#           the API and keep it, then apply a wrong address without keeping it
#           and check NetworkManager restores the network by itself
#   recovery grow a mirrored volume into its free space, replace a failed disk
#           and wait for the rebuild, then boot without the volume's disks
#           (held, nothing written to the boot disk) and with them again
#   features each feature checked on the host (#38): an account (Linux and
#           Samba), the file manager as that account on a volume, SMB from a
#           client, an AI assistant over MCP with access tokens (#138), and an
#           App Store app installed, changed and removed
#   restore back up the configuration of a NAS with a mirror and an account,
#           replace the system disk, install again and restore the backup:
#           the volume comes back with its files, owners, Place and share
#   faults  the mirror read-only, then another filesystem in its place: HSI
#           holds it and writes nothing; then it fills up during an upload
#   interrupted with /tmp on its own noexec filesystem: the power is cut
#           during an update (rolled back) and during a configuration restore
#           on a new system disk (which still goes through)
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
trap 'vm_ssh "journalctl -u hsi-server -n 80 --no-pager; tail -n 200 /var/log/hsi/app.log /var/log/hsi/root-worker.log" > "$VM_DIR/hsi-server.log" 2>&1 || true; vm_stop' EXIT

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
    || { vm_ssh 'systemctl --no-pager status hsi-server hsi-worker hsi-nats | grep -E "^. |Active:"; ss -ltnp | grep -E ":(9001|443) "; journalctl -b -u hsi-server -u hsi-worker -n 40 --no-pager; tail -n 60 /var/log/hsi/app.log /var/log/hsi/root-worker.log'; fail "health endpoint never answered (expected $want)"; }
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
import sqlite3
c = sqlite3.connect('$DB')
c.execute(\"INSERT OR IGNORE INTO User (id, username, password, isAdmin, updatedAt) VALUES ('vm-admin', 'vmadmin', 'x', 1, CURRENT_TIMESTAMP)\")
c.commit()
PY"
  sign_token vm-admin true /root/token
}

# sign_token <user id> <true|false: administrator> <file>: a session token for
# that account, for API_TOKEN=<file> api ...
sign_token() {
  vm_ssh "python3 - '$1' '$2' '$3' <<'PY'
import base64, hashlib, hmac, json, sys, time, uuid
user, admin, path = sys.argv[1], sys.argv[2] == 'true', sys.argv[3]
secret = next(l.split('=', 1)[1].strip() for l in open('/opt/hsi/.env') if l.startswith('JWT_SECRET='))
b64 = lambda d: base64.urlsafe_b64encode(d).rstrip(b'=')
head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
body = b64(json.dumps({'userId': user, 'isAdmin': admin, 'isUserManager': admin, 'capabilities': [], 'mustChangePassword': False,
                       'jti': str(uuid.uuid4()), 'iat': int(time.time()), 'exp': int(time.time()) + 7200}).encode())
sig = b64(hmac.new(secret.encode(), head + b'.' + body, hashlib.sha256).digest())
open(path, 'w').write((head + b'.' + body + b'.' + sig).decode())
PY"
}

# api <procedure> <json input>: the tRPC result data, or a failure.
api() {
  local out
  out=$(vm_ssh "curl -sk -H \"authorization: Bearer \$(cat ${API_TOKEN:-/root/token})\" -H 'content-type: application/json' --data-binary @- https://127.0.0.1:9001/trpc/$1" <<<"$2") \
    || fail "API $1 unreachable"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert "result" in r, r.get("error", r); print(json.dumps(r["result"]["data"]))' "$out" \
    || fail "API $1 failed: $out"
}

# api_query <procedure>: a tRPC query (GET, no input).
api_query() {
  local out
  out=$(vm_ssh "curl -sk -H \"authorization: Bearer \$(cat ${API_TOKEN:-/root/token})\" https://127.0.0.1:9001/trpc/$1") || fail "API $1 unreachable"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert "result" in r, r.get("error", r); print(json.dumps(r["result"]["data"]))' "$out" \
    || fail "API $1 failed: $out"
}

# api_get <procedure> <json input>: a tRPC query that takes an input.
api_get() {
  local out
  out=$(vm_ssh "curl -sk -G -H \"authorization: Bearer \$(cat ${API_TOKEN:-/root/token})\" --data-urlencode input@- https://127.0.0.1:9001/trpc/$1" <<<"$2") \
    || fail "API $1 unreachable"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert "result" in r, r.get("error", r); print(json.dumps(r["result"]["data"]))' "$out" \
    || fail "API $1 failed: $out"
}

# wait_job <reply with a jobId> <what>: waits for the worker job to complete,
# and fails with the job's own error otherwise.
wait_job() {
  local job status i
  job=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["jobId"])' "$1")
  for i in $(seq 1 60); do
    status=$(api_get tasks.get "{\"jobId\":\"$job\"}")
    case $(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["status"])' "$status") in
      completed) return ;;
      failed) fail "$2: $status" ;;
    esac
    sleep 1
  done
  fail "$2: the job did not end: $status"
}

# api_error <procedure> <json input>: the error message of a call that must fail.
api_error() {
  local out
  out=$(vm_ssh "curl -sk -H \"authorization: Bearer \$(cat ${API_TOKEN:-/root/token})\" -H 'content-type: application/json' --data-binary @- https://127.0.0.1:9001/trpc/$1" <<<"$2") \
    || fail "API $1 unreachable"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert "error" in r, r; print(r["error"]["message"])' "$out" \
    || fail "API $1 was accepted: $out"
}

# apply_plan <op> <json input> [router, storage by default]: previews a plan,
# applies exactly it, and prints its reply.
apply_plan() {
  local plan fp result router="${3:-storage}"
  plan=$(api "$router.plan" "{\"op\":\"$1\",\"input\":$2}")
  fp=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["fingerprint"])' "$plan")
  result=$(api "$router.execute" "{\"op\":\"$1\",\"input\":$2,\"fingerprint\":\"$fp\"}")
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["ok"], r; print(json.dumps(r.get("reply")))' "$result" \
    || fail "$1 failed: $result"
}

# The blank data disks, by the serial QEMU gives them.
data_disk() { vm_ssh "basename \$(readlink -f /dev/disk/by-id/virtio-HSI-DATA-$1)"; }

# create_mirror [percent of the volume group the volume takes, 100 by default]
create_mirror() {
  local a b input plan fp result
  a=$(data_disk 1); b=$(data_disk 2)
  log "Creating a mirrored volume on $a and $b through the API"
  input="{\"disks\":[\"$a\",\"$b\"],\"redundancy\":\"raid1\",\"vg\":\"vmvg\",\"lv\":\"vmlv\",\"lvPercent\":${1:-100},\"label\":\"vmdata\",\"mountpoint\":\"/srv/vm-mirror\",\"access\":\"shared\"}"
  input="{\"volume\":$input,\"place\":{\"name\":\"Mirror\"},\"share\":{\"smbName\":\"mirror\"}}"
  plan=$(api storage.volumePlan "{\"input\":$input}")
  fp=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["fingerprint"])' "$plan")
  result=$(api storage.volumeApply "{\"input\":$input,\"fingerprint\":\"$fp\"}")
  python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["ok"], r' "$result" || fail "volume creation failed: $result"
}

expect_mirror() {
  # Each check names itself; a failure shows the state it looked at.
  vm_ssh 'md=$(lsblk -nro NAME,TYPE | awk "\$2==\"raid1\"{print \$1; exit}")
    check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then echo "ok   $what"; else echo "FAIL $what"; failed=1; fi; }
    failed=0
    check "a RAID 1 array exists" test -n "$md"
    check "the array has 2 active devices" sh -c "mdadm --detail /dev/$md | grep -Eq \"Active Devices *: *2\""
    check "mdadm.conf lists the array" grep -q "^ARRAY " /etc/mdadm/mdadm.conf
    check "the logical volume exists" sh -c "lvs --noheadings -o lv_name vmvg | grep -qw vmlv"
    check "the volume is mounted" findmnt /srv/vm-mirror
    check "fstab mounts it by UUID with nofail" sh -c "grep -E \"^UUID=[^[:space:]]+[[:space:]]+/srv/vm-mirror[[:space:]]\" /etc/fstab | grep -q nofail"
    check "the volume is writable" sh -c "touch /srv/vm-mirror/.w && rm /srv/vm-mirror/.w"
    if [ "$failed" = 1 ]; then
      echo "--- lsblk"; lsblk -o NAME,TYPE,SIZE,MOUNTPOINTS
      echo "--- mdadm"; mdadm --detail /dev/$md 2>&1 | head -30
      echo "--- mdadm.conf"; grep -v "^#" /etc/mdadm/mdadm.conf 2>&1
      echo "--- fstab"; cat /etc/fstab
      exit 1
    fi' || fail "the mirrored volume is not as requested on the host"
  vm_ssh "python3 -c 'import sqlite3; c=sqlite3.connect(\"file:$DB?mode=ro\",uri=True); assert c.execute(\"select count(*) from Place where path=\\\"/srv/vm-mirror\\\"\").fetchone()[0]==1'" \
    || fail "no Place for the volume"
  # HSI keeps its own smb.conf and points smbd at it (systemd drop-in).
  vm_ssh 'conf=$(systemctl show -p ExecStart smbd | grep -o -- "--configfile=[^ ;]*" | cut -d= -f2)
    testparm -s "${conf:-/etc/samba/smb.conf}" 2>/dev/null | awk "/^\[/{s=\$0} s==\"[mirror]\" && /path = \/srv\/vm-mirror\$/{f=1} END{exit !f}"' \
    || { vm_ssh 'cat /etc/nasui/samba/smb.conf'; fail "no SMB share for the volume"; }
  log "Mirror, LVM, mount, fstab, Place and share in place"
}

# The cloud image's network goes to NetworkManager, as on a server where it
# manages the interface. Run detached: SSH drops while the network switches.
network_to_networkmanager() {
  log "Handing the network to NetworkManager"
  vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq network-manager >/dev/null' || fail "could not install NetworkManager"
  vm_ssh 'cat > /root/to-nm.sh <<"SH"
set -x
nic=$(ip -o -4 route show default | awk "{print \$5; exit}")
printf "[keyfile]\nunmanaged-devices=none\n[ifupdown]\nmanaged=true\n" > /etc/NetworkManager/conf.d/99-hsi-test.conf
for f in /etc/netplan/*.yaml; do [ -e "$f" ] && mv "$f" "$f.disabled"; done
[ -f /etc/network/interfaces ] && sed -i "/$nic/d" /etc/network/interfaces
rm -f /etc/network/interfaces.d/*
systemctl disable --now systemd-networkd.service systemd-networkd.socket 2>/dev/null
systemctl restart NetworkManager
sleep 2
nmcli connection add type ethernet ifname "$nic" con-name hsi-test ipv4.method auto ipv6.method ignore
nmcli connection up hsi-test
SH
nohup bash /root/to-nm.sh >/root/to-nm.log 2>&1 &' || true
  sleep 20
  vm_wait_ssh 300
  vm_ssh 'nmcli -t -f DEVICE,STATE,CONNECTION device status' || fail "NetworkManager does not answer"
}

nic_method() { vm_ssh 'nmcli -t -f ipv4.method connection show hsi-test | cut -d: -f2'; }

network_scenario() {
  local status nic plan fp reply checkpoint input
  status=$(api_query network.status)
  nic=$(python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert not s.get("unavailable"), s; m=[i for i in s["interfaces"] if i["managed"]]; assert m, s; print(m[0]["device"])' "$status") \
    || fail "no interface HSI can manage: $status"
  log "Switching $nic to manual addressing at the same address, then keeping it"
  input="{\"op\":\"network.ipv4\",\"input\":{\"device\":\"$nic\",\"method\":\"manual\",\"address\":\"10.0.2.15/24\",\"gateway\":\"10.0.2.2\",\"dns\":[\"10.0.2.3\"]}}"
  plan=$(api storage.plan "$input")
  fp=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["fingerprint"])' "$plan")
  reply=$(api storage.execute "${input%\}},\"fingerprint\":\"$fp\"}")
  checkpoint=$(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); assert r["ok"], r; print(r["reply"]["checkpoint"])' "$reply") || fail "network change failed: $reply"
  [[ $(nic_method) == manual ]] || fail "the connection is not manual after the change"
  api_query network.status | python3 -c 'import json,sys; s=json.load(sys.stdin); assert sys.argv[1] in s["pending"], s["pending"]' "$checkpoint" || fail "the change is not listed as waiting"
  api network.confirm "{\"checkpoint\":\"$checkpoint\"}" >/dev/null
  sleep 5
  [[ $(nic_method) == manual ]] || fail "the kept change did not stay"
  log "Kept: $nic is manual"

  log "Applying an address that cuts SSH off, without keeping it"
  input="{\"op\":\"network.ipv4\",\"input\":{\"device\":\"$nic\",\"method\":\"manual\",\"address\":\"10.0.2.99/24\",\"gateway\":\"10.0.2.2\"}}"
  plan=$(api storage.plan "$input")
  fp=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["fingerprint"])' "$plan")
  # The reply may never come back: the address the API answers on changes.
  vm_ssh "nohup curl -sk -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/json' --data-binary '${input%\}},\"fingerprint\":\"$fp\"}' https://127.0.0.1:9001/trpc/storage.execute >/root/cut.json 2>&1 &" || true
  sleep 30
  vm_ssh true 2>/dev/null && fail "SSH still answered at the old address: the wrong address was not applied"
  log "SSH cut off as expected; waiting for NetworkManager to restore the network"
  vm_wait_ssh 300
  vm_ssh 'ip -4 -o addr show' | grep -q '10.0.2.15/24' || fail "the previous address is not back"
  [[ $(nic_method) == manual ]] || fail "the previous settings are not back"
  vm_ssh "nmcli -t -f ipv4.addresses connection show hsi-test" | grep -q '10.0.2.15/24' || fail "the connection still has the wrong address"
  log "NetworkManager restored the previous settings by itself"
}

# Files on the mirror, owned by a non-root account: their content, owner and
# mode must come through every step unchanged.
add_mirror_data() {
  log "Writing files on the mirror"
  vm_ssh 'mkdir -p /srv/vm-mirror/data/nested && for i in 1 2 3 4; do head -c 8M /dev/urandom > /srv/vm-mirror/data/nested/file$i.bin; done
    chown -R 1234:1234 /srv/vm-mirror/data && chmod 0750 /srv/vm-mirror/data/nested
    cd /srv/vm-mirror/data && { find . -type f -exec sha256sum {} +; find . -printf "%p %u %g %m\n"; } | sort' > "$VM_DIR/mirror.sum"
}

expect_mirror_data() {
  # Kept on this side: the restore scenario replaces the system disk.
  vm_ssh 'cd /srv/vm-mirror/data && { find . -type f -exec sha256sum {} +; find . -printf "%p %u %g %m\n"; } | sort' | diff "$VM_DIR/mirror.sum" - \
    || fail "files on the mirror were lost or changed"
  log "Files on the mirror intact"
}

mirror_array() { vm_ssh 'lsblk -nro NAME,TYPE | awk "\$2==\"raid1\"{print \$1; exit}"'; }

# Waits for the mirror to be in sync on two disks: HSI refuses to reshape an
# array during a resync or a rebuild.
wait_clean() {
  local md
  md=$(mirror_array)
  vm_ssh "for i in \$(seq 1 180); do d=\$(mdadm --detail /dev/$md); echo \"\$d\" | grep -Eq 'State : (clean|active) *\$' && echo \"\$d\" | grep -Eq 'Active Devices *: *2' && exit 0; sleep 5; done; mdadm --detail /dev/$md; exit 1" \
    || fail "$md did not get in sync"
}

# expect_hold <blocked|back|none> [reason]: the guard's view of the mirror,
# which it refreshes every minute.
expect_hold() {
  local got="" deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    got=$(api_query storage.volumes.list | python3 -c 'import json,sys; v=[x for x in json.load(sys.stdin) if x["mountPoint"]=="/srv/vm-mirror"]; h=(v[0]["hold"] or {}) if v else {}; print((h.get("status") or "none") + ":" + (h.get("reason") or "") if v else "unlisted:")')
    [[ ${got%%:*} == "$1" && ( -z ${2:-} || ${got#*:} == "$2" ) ]] && { log "Hold on the mirror: $got"; return; }
    sleep 10
  done
  fail "the hold on the mirror is $got, expected $1${2:+:$2}"
}

# expect_held_off: the file manager is refused on the held mirror and its
# share is not offered.
expect_held_off() {
  api_error fs.mkdir '{"parentPath":"/srv/vm-mirror","name":"stray"}' | grep -q 'resume it in Storage first' \
    || fail "the file manager was not refused on the held volume"
  vm_ssh '! test -e /srv/vm-mirror/stray' || fail "the file manager wrote on the held volume"
  vm_ssh 'conf=$(systemctl show -p ExecStart smbd | grep -o -- "--configfile=[^ ;]*" | cut -d= -f2)
    testparm -s "${conf:-/etc/samba/smb.conf}" 2>/dev/null | awk "/^\[/{s=\$0} s==\"[mirror]\" && /available = No/{f=1} END{exit !f}"' \
    || fail "the share of the held volume is still offered"
}

# resume_mirror: the mirror is back as it should be; the administrator resumes it.
resume_mirror() {
  expect_hold back
  api storage.volumes.resume '{"mountPoint":"/srv/vm-mirror"}' >/dev/null
  expect_hold none
}

expand_mirror() {
  local uuid before after
  uuid=$(vm_ssh 'findmnt -no UUID /srv/vm-mirror')
  before=$(vm_ssh 'findmnt -bno SIZE /srv/vm-mirror')
  wait_clean
  log "Growing the mirror into the free space of its volume group"
  apply_plan volume.expand "{\"uuid\":\"$uuid\",\"mode\":\"vgFree\"}" >/dev/null
  after=$(vm_ssh 'findmnt -bno SIZE /srv/vm-mirror')
  (( after > before * 3 / 2 )) || fail "the filesystem did not grow: $before -> $after bytes"
  vm_ssh 'lvs --noheadings -o vg_free --units b --nosuffix vmvg' | awk '{exit !($1 < 64*1024*1024)}' \
    || fail "the volume group still has free space after the expansion"
  log "Grown from $before to $after bytes"
}

replace_disk() {
  local md old new
  md=$(mirror_array); old=$(data_disk 2); new=$(data_disk 3)
  log "Replacing $old with $new in $md"
  apply_plan raid.fail "{\"name\":\"$md\",\"device\":\"$old\"}" >/dev/null
  apply_plan raid.remove "{\"name\":\"$md\",\"device\":\"$old\"}" >/dev/null
  apply_plan raid.add "{\"name\":\"$md\",\"device\":\"$new\"}" >/dev/null
  wait_clean
  vm_ssh "mdadm --detail /dev/$md | grep -q '/dev/$new' && ! mdadm --detail /dev/$md | grep -q '/dev/$old\$'" \
    || fail "$md does not have $new in place of $old"
  log "$md rebuilt onto $new"
}

# Booted without the mirror's disks: HSI runs, holds the volume, and nothing
# can write into the empty mount point on the boot disk.
expect_missing() {
  vm_ssh '! findmnt /srv/vm-mirror >/dev/null' || fail "something is mounted on /srv/vm-mirror"
  expect_hold blocked
  vm_ssh 'touch /srv/vm-mirror/stray 2>/dev/null' && fail "root could write into the empty mount point"
  vm_ssh '[ -z "$(ls -A /srv/vm-mirror)" ]' || fail "the empty mount point is not empty"
  expect_held_off
  log "Missing volume held; the boot disk was not written"
}

# vm_until <seconds> <what> <command>: waits for a command in the VM to succeed.
vm_until() {
  vm_ssh "for i in \$(seq 1 $1); do ($3) >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1" || fail "$2"
}

USER_PASSWORD="vm-user-password"

# An account made through HSI: a Linux account, a Samba account, and HSI's
# own list reads it back.
account_feature() {
  local id
  log "Creating the account vmuser through the API"
  id=$(api user.create "{\"username\":\"vmuser\",\"password\":\"$USER_PASSWORD\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  vm_ssh 'id vmuser && getent passwd vmuser | cut -d: -f7 | grep -q nologin' >/dev/null || fail "vmuser has no Linux account, or one with a login shell"
  vm_ssh 'pdbedit -L 2>/dev/null | grep -q "^vmuser:"' || fail "vmuser has no Samba account"
  api_query user.list | python3 -c 'import json,sys; assert any(u["username"]=="vmuser" for u in json.load(sys.stdin))' || fail "HSI does not list vmuser"
  echo "$id" > "$VM_DIR/vmuser.id"
}

# grant_vmuser: vmuser may read, write and delete in the mirror's Place, and
# /root/token-vmuser signs it in.
grant_vmuser() {
  local id place
  id=$(cat "$VM_DIR/vmuser.id")
  place=$(api_query place.list | python3 -c 'import json,sys; print(next(p["id"] for p in json.load(sys.stdin) if p["path"]=="/srv/vm-mirror"))')
  api permission.upsert "{\"placeId\":\"$place\",\"subjectType\":\"user\",\"subjectId\":\"$id\",\"canRead\":true,\"canWrite\":true,\"canDelete\":true,\"canShare\":false}" >/dev/null
  # The grant reaches Linux in the background: vmuser joins the group that
  # may write in Places.
  vm_until 60 "vmuser did not join hsi-share after getting write access" 'id -nG vmuser | grep -qw hsi-share'
  sign_token "$id" false /root/token-vmuser
}

# The file manager as vmuser, in the mirror's Place: the files it makes
# are its own on the host.
files_feature() {
  grant_vmuser
  log "File manager as vmuser on the mirror"
  wait_job "$(API_TOKEN=/root/token-vmuser api fs.mkdir '{"parentPath":"/srv/vm-mirror","name":"from-ui"}')" "making a folder as vmuser"
  wait_job "$(API_TOKEN=/root/token-vmuser api fs.touch '{"parentPath":"/srv/vm-mirror/from-ui","name":"note.txt"}')" "making a file as vmuser"
  vm_ssh 'test -f /srv/vm-mirror/from-ui/note.txt' || fail "the file made through the file manager is not on the host"
  [[ $(vm_ssh 'stat -c %U /srv/vm-mirror/from-ui /srv/vm-mirror/from-ui/note.txt | sort -u') == vmuser ]] \
    || fail "files made by vmuser are not its own: $(vm_ssh 'stat -c "%n %U" /srv/vm-mirror/from-ui /srv/vm-mirror/from-ui/note.txt')"
  wait_job "$(API_TOKEN=/root/token-vmuser api fs.rename '{"path":"/srv/vm-mirror/from-ui/note.txt","newName":"renamed.txt"}')" "renaming as vmuser"
  vm_ssh 'test -f /srv/vm-mirror/from-ui/renamed.txt && ! test -e /srv/vm-mirror/from-ui/note.txt' || fail "the rename is not on the host"
  API_TOKEN=/root/token-vmuser api_get fs.list '{"path":"/srv/vm-mirror/from-ui"}' | grep -q renamed.txt || fail "the file manager does not list the renamed file"
  wait_job "$(API_TOKEN=/root/token-vmuser api fs.delete '{"path":"/srv/vm-mirror/from-ui/renamed.txt"}')" "deleting as vmuser"
  vm_ssh '! test -e /srv/vm-mirror/from-ui/renamed.txt' || fail "the delete is not on the host"
  # Outside its Places, vmuser is refused.
  API_TOKEN=/root/token-vmuser api_error fs.mkdir '{"parentPath":"/root","name":"nope"}' >/dev/null
  vm_ssh '! test -e /root/nope' || fail "vmuser wrote outside its Places"
  log "vmuser created, renamed and deleted its files"
}

# A client connects to the share with vmuser's password and writes in it.
smb_feature() {
  log "SMB client on the share as vmuser"
  vm_ssh "smbclient //127.0.0.1/mirror -U 'vmuser%$USER_PASSWORD' -c 'mkdir from-smb; put /etc/hostname from-smb/hello.txt; ls from-smb/*'" \
    > "$VM_DIR/smbclient.log" 2>&1 || { cat "$VM_DIR/smbclient.log"; fail "vmuser could not write on the share"; }
  [[ $(vm_ssh 'stat -c %U /srv/vm-mirror/from-smb/hello.txt') == vmuser ]] || fail "the file written over SMB is not vmuser's"
  vm_ssh 'cmp -s /etc/hostname /srv/vm-mirror/from-smb/hello.txt' || fail "the file written over SMB differs"
  vm_ssh "smbclient //127.0.0.1/mirror -U 'vmuser%wrong-password' -c ls" >/dev/null 2>&1 && fail "the share took a wrong password"
  log "SMB: vmuser writes its own files, a wrong password is refused"
}

stack_state() { vm_ssh "docker compose ls -a --format json" | python3 -c 'import json,sys; s=[x for x in json.load(sys.stdin) if x["Name"]==sys.argv[1]]; print(s[0]["Status"] if s else "absent")' "$1"; }

# An App Store app: installed, its port changed, removed; each step checked
# with Docker on the host and read back through HSI.
app_feature() {
  local reply raw
  log "Installing IT Tools from the App Store"
  reply=$(apply_plan app.install '{"id":"it-tools","name":"ittools","ports":[{"container":80,"host":8085}]}' apps)
  echo "$reply" > "$VM_DIR/app-install.json"
  vm_until 300 "IT Tools does not answer on port 8085" 'curl -sf http://127.0.0.1:8085/ | grep -qi "it-tools\|IT Tools"'
  [[ $(stack_state ittools) == running* ]] || fail "the ittools stack is $(stack_state ittools)"
  vm_ssh 'test -f /opt/containers/ittools/compose.yaml && docker compose -f /opt/containers/ittools/compose.yaml config -q' || fail "no valid compose.yaml for ittools"
  api_query container.app.list | python3 -c 'import json,sys; a=[x for x in json.load(sys.stdin) if x["name"]=="ittools"]; assert a and a[0]["status"]=="running", a' \
    || fail "HSI does not read ittools back as running"

  log "Moving IT Tools to port 8086 by editing its compose.yaml"
  raw=$(vm_ssh 'sed "s/8085:80/8086:80/" /opt/containers/ittools/compose.yaml')
  grep -q '8086:80' <<<"$raw" || fail "the compose.yaml does not publish 8085:80: $(vm_ssh 'cat /opt/containers/ittools/compose.yaml')"
  apply_plan app.save "$(python3 -c 'import json,sys; print(json.dumps({"name":"ittools","raw":sys.stdin.read()}))' <<<"$raw")" apps >/dev/null
  apply_plan app.apply '{"name":"ittools"}' apps >/dev/null
  vm_until 120 "IT Tools does not answer on port 8086" 'curl -sf http://127.0.0.1:8086/ >/dev/null'
  vm_ssh 'curl -sf -m 3 http://127.0.0.1:8085/' >/dev/null 2>&1 && fail "IT Tools still answers on port 8085"

  log "Removing IT Tools"
  apply_plan app.remove '{"name":"ittools"}' apps >/dev/null
  vm_until 120 "the ittools stack is still there" '! docker compose ls -a | grep -q "^ittools "'
  vm_until 30 "the ittools folder is still there" '! test -e /opt/containers/ittools'
  api_query container.app.list | python3 -c 'import json,sys; assert not [x for x in json.load(sys.stdin) if x["name"]=="ittools"]' \
    || fail "HSI still lists ittools"
  log "IT Tools installed, moved and removed"
}

# mcp <access token> <json-rpc request>: the reply of HSI's MCP endpoint (#138).
mcp() {
  vm_ssh "curl -sk -H 'authorization: Bearer $1' -H 'accept: application/json, text/event-stream' -H 'content-type: application/json' \
    --data-binary @- https://127.0.0.1:9001/mcp" <<<"$2"
}

# mcp_call <access token> <tool> <json arguments>: the tool's result, decoded.
mcp_call() {
  local out
  out=$(mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}")
  python3 -c 'import json,sys; r=json.loads(sys.argv[1])["result"]; assert not r.get("isError"), r; print(r["content"][0]["text"])' "$out" \
    || fail "MCP $2 failed: $out"
}

# An AI assistant over MCP: an admin's token reads the storage and a file and
# is audited; vmuser's token only sees what vmuser may; a revoked token and a
# dashboard session are refused.
mcp_feature() {
  local admin user tools
  log "MCP: access tokens and tools"
  admin=$(api apiToken.create '{"name":"vm admin","scopes":["files:read","storage:read","system:read","apps:read","users:read"],"expiresInDays":7}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')
  mcp "$admin" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"vm","version":"1"}}}' \
    | grep -q '"serverInfo"' || fail "the MCP endpoint does not answer initialize"
  tools=$(mcp "$admin" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
  grep -q '"storage_overview"' <<<"$tools" && ! grep -q '"fs_delete\|"delete_' <<<"$tools" || fail "unexpected MCP tools for a read-only admin token: $tools"
  mcp_call "$admin" storage_overview '{}' | grep -q '/srv/vm-mirror' || fail "storage_overview does not show the mirror"
  mcp_call "$admin" list_files '{"path":"/srv/vm-mirror/from-smb"}' | grep -q 'hello.txt' || fail "list_files does not show hello.txt"
  [[ $(mcp_call "$admin" read_text_file '{"path":"/srv/vm-mirror/from-smb/hello.txt"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"].strip())') \
    == "$(vm_ssh 'cat /etc/hostname')" ]] || fail "read_text_file does not return the file"
  api_get audit.list '{"limit":20,"via":"mcp"}' | grep -q '"fs.readText"' || fail "the read through MCP is not in the audit log"

  user=$(API_TOKEN=/root/token-vmuser api apiToken.create '{"name":"vm user","scopes":["files:read","storage:read","apps:read","users:read","system:read"]}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])')
  tools=$(mcp "$user" '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
  grep -q '"list_files"' <<<"$tools" && ! grep -q '"storage_overview"\|"list_apps"' <<<"$tools" || fail "vmuser's token is offered tools beyond vmuser's rights: $tools"
  mcp_call "$user" list_files '{"path":"/srv/vm-mirror/from-smb"}' | grep -q 'hello.txt' || fail "vmuser's token cannot list its Place"
  mcp "$user" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_files","arguments":{"path":"/root"}}}' | grep -q '"isError":true' \
    || fail "vmuser's token listed a folder outside its Places"

  # Only /mcp takes tokens, and /mcp only takes tokens.
  vm_ssh "curl -sk -o /dev/null -w '%{http_code}' -H 'authorization: Bearer $admin' https://127.0.0.1:9001/trpc/user.list" | grep -qx 401 \
    || fail "an access token was accepted by the dashboard API"
  [[ $(vm_ssh "curl -sk -o /dev/null -w '%{http_code}' -X POST -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/json' --data '{}' https://127.0.0.1:9001/mcp") == 401 ]] \
    || fail "a dashboard session was accepted on /mcp"
  api apiToken.revoke "{\"id\":\"$(api_query apiToken.list | python3 -c 'import json,sys; print(next(t["id"] for t in json.load(sys.stdin) if t["name"]=="vm admin"))')\"}" >/dev/null
  [[ $(vm_ssh "curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'authorization: Bearer $admin' -H 'content-type: application/json' --data '{}' https://127.0.0.1:9001/mcp") == 401 ]] \
    || fail "a revoked token still opens /mcp"
  log "MCP: tools within each token's rights, reads audited, revocation immediate"
}

BACKUP_PASSWORD="vm-test-config-backup-password"

# An account made through HSI (Linux and Samba), owning files on the mirror.
add_account_data() {
  log "Creating the account vmuser and giving it files on the mirror"
  api user.create '{"username":"vmuser","password":"vm-user-password"}' >/dev/null
  vm_ssh 'id vmuser && mkdir -p /srv/vm-mirror/vmuser && head -c 4M /dev/urandom > /srv/vm-mirror/vmuser/own.bin && chown -R vmuser:vmuser /srv/vm-mirror/vmuser' >/dev/null \
    || fail "the account vmuser has no Linux account"
  vm_ssh 'stat -c "%u:%g" /srv/vm-mirror/vmuser/own.bin' > "$VM_DIR/vmuser.ids"
}

expect_account_data() {
  local ids
  ids=$(vm_ssh 'stat -c "%U %u:%g" /srv/vm-mirror/vmuser/own.bin')
  [[ $ids == "vmuser $(cat "$VM_DIR/vmuser.ids")" ]] || fail "the files of vmuser are now owned by $ids, expected vmuser $(cat "$VM_DIR/vmuser.ids")"
  log "vmuser owns its files with the same ids"
}

config_backup() {
  log "Downloading a configuration backup"
  vm_ssh "curl -sfk -X POST -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/json' \
    --data '{\"password\":\"$BACKUP_PASSWORD\"}' -o /root/config.hsibak https://127.0.0.1:9001/system/config-backup" \
    || fail "the configuration backup failed"
  vm_get /root/config.hsibak "$VM_DIR/config.hsibak"
  [[ -s $VM_DIR/config.hsibak ]] || fail "the configuration backup is empty"
}

# restore_preview: uploads the backup and prints the token of its preview.
restore_preview() {
  local preview
  vm_put "$VM_DIR/config.hsibak" /root/config.hsibak
  preview=$(vm_ssh "curl -sk -X POST -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/vnd.hsi.config-backup' \
    -H \"x-hsi-backup-password: $(printf %s "$BACKUP_PASSWORD" | base64 -w0)\" --data-binary @/root/config.hsibak \
    https://127.0.0.1:9001/system/config-restore/preview")
  echo "$preview" > "$VM_DIR/restore-preview.json"
  python3 -c 'import json,sys; p=json.loads(sys.argv[1]); assert not p.get("conflicts"), p; print(p["token"])' "$preview" \
    || fail "the restore preview was refused: $preview"
}

config_restore() {
  local token
  log "Restoring the configuration backup"
  token=$(restore_preview)
  vm_ssh "curl -sfk -X POST -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/json' \
    --data '{\"token\":\"$token\"}' https://127.0.0.1:9001/system/config-restore/apply" >/dev/null \
    || fail "the restore was refused"
  # The server restarts on the restored database.
  sleep 10
}

# The update helpers' paths on the VM.
UPDATE_STATE=/var/lib/hsi/update

install_published() {
  published=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')
  log "Installing the published $published"
  vm_ssh "curl -fsSL https://github.com/$REPO/releases/download/$published/install.sh -o /root/published-install.sh && VERSION=$published bash /root/published-install.sh" > "$VM_DIR/install-$published.log" 2>&1 \
    || { tail -40 "$VM_DIR/install-$published.log"; fail "install of $published failed"; }
}

# /tmp on its own filesystem, noexec as hardened servers have it: installing,
# updating and restoring must neither rename across it nor run from it.
separate_tmp() {
  vm_ssh 'grep -q "[[:space:]]/tmp[[:space:]]" /etc/fstab || echo "tmpfs /tmp tmpfs nosuid,nodev,noexec 0 0" >> /etc/fstab
    systemctl daemon-reload
    if findmnt -n /tmp >/dev/null; then mount -o remount,nosuid,nodev,noexec /tmp; else mount /tmp; fi
    [ "$(stat -c %d /tmp)" != "$(stat -c %d /)" ] && findmnt -no OPTIONS /tmp | grep -qw noexec' \
    || fail "/tmp is not a separate noexec filesystem"
  log "/tmp is a separate noexec filesystem"
}

# interrupted_update <installed version>: the power goes while an update to
# the built archive switches to the new version or waits for its health. The
# worker rolls the update back when it starts again.
interrupted_update() {
  log "Updating to $version, cutting the power at the switch"
  vm_put "$archive" "/root/$(basename "$archive")"
  vm_put "$root/scripts/install.sh" /root/install.sh
  vm_ssh "VERSION=$version HSI_RELEASE_ARCHIVE=/root/$(basename "$archive") nohup setsid bash /root/install.sh > /root/update.log 2>&1 < /dev/null &"
  vm_ssh "for i in \$(seq 1 18000); do grep -Eqs '\"step\": \"(switch|health)\"' $UPDATE_STATE/in-progress.json && exit 0; sleep 0.05; done; exit 1" \
    || { vm_ssh 'tail -30 /root/update.log'; fail "the update never reached its switch"; }
  vm_cut
  vm_start
  expect_running "$1"
  # The recovery (its own unit) writes its result once the version it went
  # back to is healthy: HSI may answer a little before.
  vm_ssh "for i in \$(seq 1 300); do test -e $UPDATE_STATE/in-progress.json || break; sleep 1; done
    ! test -e $UPDATE_STATE/in-progress.json && python3 -c 'import json,sys; sys.exit(json.load(open(\"$UPDATE_STATE/last.json\"))[\"status\"]!=\"rolled-back\")'" \
    || { vm_ssh "cat $UPDATE_STATE/last.json $UPDATE_STATE/in-progress.json; journalctl -u hsi-update-recover -u hsi-worker -b -n 60 --no-pager"; fail "the interrupted update was not rolled back"; }
  log "The interrupted update was rolled back to $1"
}

# The power goes while a restore is applied: the server is frozen as soon as
# the worker has made the accounts, before it swaps the database. HSI starts
# again, and the restore still goes through.
interrupted_restore() {
  local token
  log "Restoring the configuration backup, cutting the power halfway"
  token=$(restore_preview)
  vm_ssh "nohup curl -sk -X POST -H \"authorization: Bearer \$(cat /root/token)\" -H 'content-type: application/json' \
      --data '{\"token\":\"$token\"}' https://127.0.0.1:9001/system/config-restore/apply > /root/apply.log 2>&1 < /dev/null &
    for i in \$(seq 1 200000); do getent passwd vmuser >/dev/null && break; done
    kill -STOP \$(systemctl show -p MainPID --value hsi-server)
    getent passwd vmuser" >/dev/null || fail "the restore never made the account vmuser"
  vm_cut
  vm_start
  expect_running "$version"
  vm_ssh 'id vmuser' >/dev/null || fail "the account the restore made is gone"
  if vm_ssh "python3 -c 'import sqlite3,sys; sys.exit(not sqlite3.connect(\"file:$DB?mode=ro\",uri=True).execute(\"select 1 from User where username=\\\"vmuser\\\"\").fetchone())'"; then
    log "The database was swapped before the cut"
  else
    log "The cut left the database as it was: restoring again"
    api_setup
    config_restore
    expect_running "$version"
  fi
  api_setup
}

# readonly_fault: the mirror is remounted read-only (as errors=remount-ro
# would), then writable again.
readonly_fault() {
  log "Remounting the mirror read-only"
  vm_ssh 'mount -o remount,ro /srv/vm-mirror' || fail "could not remount the mirror read-only"
  expect_hold blocked readonly
  expect_held_off
  vm_ssh 'mount -o remount,rw /srv/vm-mirror' || fail "could not remount the mirror writable"
  resume_mirror
}

# wrong_fault: another filesystem is mounted in place of the mirror. Nothing
# is written on it, then the mirror comes back.
wrong_fault() {
  local other
  other=$(data_disk 4)
  log "Mounting another filesystem ($other) in place of the mirror"
  vm_ssh "mkfs.ext4 -q -F /dev/$other && umount /srv/vm-mirror && mount /dev/$other /srv/vm-mirror" || fail "could not mount $other on /srv/vm-mirror"
  expect_hold blocked wrong
  expect_held_off
  vm_ssh '[ -z "$(ls -A /srv/vm-mirror | grep -vx lost+found)" ]' || fail "something was written on the other filesystem"
  vm_ssh 'umount /srv/vm-mirror && mount /srv/vm-mirror' || fail "could not mount the mirror again"
  resume_mirror
}

# upload_chunk <upload id> <chunk index>: sends one 1 MiB chunk of the 2 MiB
# /root/upload.bin to the mirror as vmuser, and prints the HTTP status.
upload_chunk() {
  vm_ssh "dd if=/root/upload.bin bs=1M skip=$2 count=1 status=none | curl -sk -o /root/upload.out -w '%{http_code}' \
    -H \"authorization: Bearer \$(cat /root/token-vmuser)\" -H 'content-type: application/octet-stream' \
    -H 'x-upload-id: $1' -H 'x-chunk-index: $2' -H 'x-total-chunks: 2' -H 'x-chunk-offset: $(( $2 * 1048576 ))' \
    -H 'x-total-bytes: 2097152' -H 'x-file-name: upload.bin' -H 'x-dest-dir: %2Fsrv%2Fvm-mirror' \
    --data-binary @- https://127.0.0.1:9001/files/upload/chunk"
}

# full_volume: the mirror fills up during an upload. The write is refused,
# a new upload too, HSI keeps running, and the upload ends once there is room.
full_volume() {
  local id sha status
  id=$(python3 -c 'import uuid; print(uuid.uuid4())')
  log "Uploading to the mirror as vmuser while it fills up"
  vm_ssh 'head -c 2M /dev/urandom > /root/upload.bin'
  status=$(upload_chunk "$id" 0)
  [[ $status == 200 ]] || fail "the first chunk got $status: $(vm_ssh 'cat /root/upload.out')"
  vm_ssh 'dd if=/dev/zero of=/srv/vm-mirror/filler bs=1M status=none 2>/dev/null; sync; [ "$(df -B1 --output=avail /srv/vm-mirror | tail -1)" -lt 1048576 ]' \
    || fail "could not fill the mirror"
  status=$(upload_chunk "$id" 1)
  [[ $status == 507 ]] || fail "a chunk written on the full mirror got $status, expected 507: $(vm_ssh 'cat /root/upload.out')"
  status=$(upload_chunk "$(python3 -c 'import uuid; print(uuid.uuid4())')" 0)
  [[ $status == 507 ]] || fail "a new upload to the full mirror got $status, expected 507: $(vm_ssh 'cat /root/upload.out')"
  expect_running "$version"
  expect_hold none
  log "Making room, then sending the refused chunk again"
  vm_ssh 'rm /srv/vm-mirror/filler'
  status=$(upload_chunk "$id" 1)
  [[ $status == 200 ]] || fail "the chunk got $status after making room: $(vm_ssh 'cat /root/upload.out')"
  sha=$(vm_ssh 'sha256sum /root/upload.bin | cut -d" " -f1')
  wait_job "$(vm_ssh "curl -sk -H \"authorization: Bearer \$(cat /root/token-vmuser)\" -H 'content-type: application/json' \
    --data '{\"uploadId\":\"$id\",\"sha256\":\"$sha\"}' https://127.0.0.1:9001/files/upload/complete")" "finishing the upload"
  vm_ssh 'cmp -s /root/upload.bin /srv/vm-mirror/upload.bin && [ "$(stat -c %U /srv/vm-mirror/upload.bin)" = vmuser ] && ! ls -A /srv/vm-mirror | grep -q "^\.upload-"' \
    || fail "the upload did not end as vmuser's file, or left a partial file: $(vm_ssh 'ls -la /srv/vm-mirror')"
  log "A full mirror refused the upload; it ended once there was room"
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
    install_published
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
    # Samba is optional for the installer; the volume's share needs it.
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null' || fail "could not install Samba"
    install_build
    expect_running "$version"
    api_setup
    create_mirror
    expect_mirror
    vm_reboot
    expect_running "$version"; expect_mirror
    ;;
  network)
    network_to_networkmanager
    install_build
    expect_running "$version"
    api_setup
    network_scenario
    expect_running "$version"
    ;;
  recovery)
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null' || fail "could not install Samba"
    install_build
    expect_running "$version"
    api_setup
    create_mirror 60
    expect_mirror
    add_mirror_data
    expand_mirror
    expect_mirror; expect_mirror_data
    replace_disk
    expect_mirror; expect_mirror_data
    vm_reboot
    expect_running "$version"; expect_mirror; expect_mirror_data
    # Disk 4 alone: the mirror's disks are unplugged.
    vm_poweroff
    vm_start 4
    expect_running "$version"
    expect_missing
    vm_poweroff
    vm_start 1 3 4
    expect_running "$version"
    resume_mirror
    expect_mirror; expect_mirror_data
    ;;
  features)
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba smbclient docker.io docker-compose >/dev/null && docker compose version' \
      || fail "could not install Samba and Docker"
    install_build
    expect_running "$version"
    api_setup
    create_mirror
    expect_mirror
    account_feature
    files_feature
    smb_feature
    mcp_feature
    app_feature
    vm_reboot
    expect_running "$version"; expect_mirror
    vm_ssh 'id vmuser >/dev/null && test -f /srv/vm-mirror/from-smb/hello.txt' || fail "vmuser or its files are gone after a reboot"
    ;;
  restore)
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null' || fail "could not install Samba"
    install_build
    expect_running "$version"
    api_setup
    create_mirror
    expect_mirror
    add_mirror_data
    add_account_data
    config_backup
    vm_poweroff
    vm_new_system
    vm_start
    # An unrelated account first: ids the new system hands out by default no
    # longer match the old ones, so only a restore that keeps them passes.
    vm_ssh 'useradd -M -u 1500 squatter' || fail "could not add an account"
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba smbclient >/dev/null' || fail "could not install Samba"
    install_build
    expect_running "$version"
    api_setup
    config_restore
    expect_running "$version"
    api_setup
    apply_plan storage.reapply '{"mountPoint":"/srv/vm-mirror"}' >/dev/null
    expect_mirror; expect_mirror_data; expect_account_data
    # Samba passwords are not in the backup (documented): the account sets a
    # new password in its profile, which gives it its Samba account back.
    vmuser_id=$(vm_ssh "python3 -c 'import sqlite3; print(sqlite3.connect(\"file:$DB?mode=ro\",uri=True).execute(\"select id from User where username=\\\"vmuser\\\"\").fetchone()[0])'")
    sign_token "$vmuser_id" false /root/token-vmuser
    API_TOKEN=/root/token-vmuser api user.changePassword '{"currentPassword":"vm-user-password","newPassword":"vm-user-password-2"}' >/dev/null
    vm_ssh 'pdbedit -L 2>/dev/null | grep -q "^vmuser:"' || fail "vmuser has no Samba account after setting a new password"
    # It has no access to the mirror's Place here: signing in to Samba is
    # what the new password must allow.
    vm_ssh "smbclient -L //127.0.0.1 -U 'vmuser%vm-user-password-2'" > "$VM_DIR/smb-signin.log" 2>&1 \
      || { cat "$VM_DIR/smb-signin.log"; vm_ssh 'pdbedit -v vmuser; systemctl is-active smbd; journalctl -u hsi-worker -n 30 --no-pager | grep -i -E "samba|smb|vmuser"'; fail "Samba refuses vmuser's new password"; }
    vm_reboot
    expect_running "$version"; expect_mirror; expect_mirror_data; expect_account_data
    ;;
  faults)
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null' || fail "could not install Samba"
    install_build
    expect_running "$version"
    api_setup
    # A quarter of the disks: filling it up stays quick.
    create_mirror 25
    expect_mirror
    add_mirror_data
    readonly_fault
    wrong_fault
    expect_mirror; expect_mirror_data
    account_feature
    grant_vmuser
    full_volume
    vm_reboot
    expect_running "$version"; expect_mirror; expect_mirror_data
    ;;
  interrupted)
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null' || fail "could not install Samba"
    install_published
    expect_running "$published"
    # Installers before 1.73.1 neither flushed what they wrote nor ran their
    # stage outside /tmp: the cuts below test the built installer.
    vm_ssh sync
    separate_tmp
    add_data
    interrupted_update "$published"
    expect_data
    install_build
    expect_running "$version"; expect_ledger; expect_data
    api_setup
    create_mirror
    expect_mirror
    add_mirror_data
    add_account_data
    config_backup
    vm_poweroff
    vm_new_system
    vm_start
    separate_tmp
    vm_ssh 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null' || fail "could not install Samba"
    install_build
    expect_running "$version"
    api_setup
    interrupted_restore
    apply_plan storage.reapply '{"mountPoint":"/srv/vm-mirror"}' >/dev/null
    expect_mirror; expect_mirror_data; expect_account_data
    vm_reboot
    expect_running "$version"; expect_mirror; expect_mirror_data
    ;;
  *) fail "unknown scenario $scenario" ;;
esac
log "Scenario $scenario passed"
