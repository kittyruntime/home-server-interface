#!/usr/bin/env bash
# Disposable QEMU/KVM virtual machine for the VM tests (#17). Boots the Debian
# 13 cloud image with an overlay system disk and blank data disks, reachable
# over SSH on a forwarded local port. Everything lives in $VM_DIR and is
# thrown away with it: nothing touches the host's own disks.
set -euo pipefail

VM_IMAGE_URL="${VM_IMAGE_URL:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2}"
VM_CACHE="${VM_CACHE:-$HOME/.cache/hsi-vm}"
VM_DIR="${VM_DIR:?VM_DIR must point to a scratch directory}"
VM_SSH_PORT="${VM_SSH_PORT:-2222}"
VM_MEMORY="${VM_MEMORY:-3072}"
VM_CPUS="${VM_CPUS:-2}"
VM_DATA_DISKS="${VM_DATA_DISKS:-4}"
VM_DATA_DISK_SIZE="${VM_DATA_DISK_SIZE:-4G}"

log() { printf '\n\033[1m[vm] %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m[vm] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

vm_ssh() {
  ssh -q -i "$VM_DIR/id_ed25519" -p "$VM_SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR \
    root@127.0.0.1 "$@"
}

vm_put() {
  scp -q -i "$VM_DIR/id_ed25519" -P "$VM_SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$1" "root@127.0.0.1:$2"
}

vm_wait_ssh() {
  local deadline=$((SECONDS + ${1:-300}))
  local next=$((SECONDS + 60))
  until vm_ssh true 2>/dev/null; do
    if (( SECONDS >= next )); then
      echo "[vm] waiting for SSH: console $(wc -c < "$VM_DIR/console.log" 2>/dev/null || echo 0) bytes"
      next=$((SECONDS + 60))
    fi
    if (( SECONDS >= deadline )); then
      tail -c 4000 "$VM_DIR/console.log" 2>/dev/null || true
      fail "SSH did not come up"
    fi
    sleep 3
  done
  # cloud-init installs the test packages after SSH is up.
  vm_ssh 'cloud-init status --wait >/dev/null 2>&1 || true'
}

vm_boot() {
  mkdir -p "$VM_DIR" "$VM_CACHE"
  local base="$VM_CACHE/debian-13.qcow2"
  if [[ ! -s "$base" ]]; then
    log "Downloading the Debian 13 cloud image"
    curl -fsSL "$VM_IMAGE_URL" -o "$base.part" && mv "$base.part" "$base"
  fi
  qemu-img info "$base" | grep -E "file format|virtual size|disk size" || fail "the cloud image is unreadable"
  ssh-keygen -q -t ed25519 -N '' -f "$VM_DIR/id_ed25519" <<<y >/dev/null
  qemu-img create -q -f qcow2 -b "$base" -F qcow2 "$VM_DIR/system.qcow2" 20G
  cat > "$VM_DIR/user-data" <<USERDATA
#cloud-config
hostname: hsi-vm
disable_root: false
ssh_pwauth: false
users:
  - name: root
    ssh_authorized_keys: ["$(cat "$VM_DIR/id_ed25519.pub")"]
package_update: true
packages: [curl, ca-certificates, python3, openssl]
USERDATA
  printf 'instance-id: hsi-vm\nlocal-hostname: hsi-vm\n' > "$VM_DIR/meta-data"
  cloud-localds "$VM_DIR/seed.iso" "$VM_DIR/user-data" "$VM_DIR/meta-data"
  # Data disks are blank: the system disk must be the one the BIOS boots
  # (bootindex), or it stops on the first data disk.
  local disks=() i
  for ((i = 1; i <= VM_DATA_DISKS; i++)); do
    qemu-img create -q -f qcow2 "$VM_DIR/data$i.qcow2" "$VM_DATA_DISK_SIZE"
    disks+=(-drive "file=$VM_DIR/data$i.qcow2,if=none,id=data$i,format=qcow2"
            -device "virtio-blk-pci,drive=data$i,serial=HSI-DATA-$i")
  done
  log "Booting the VM (${VM_DATA_DISKS} data disks of ${VM_DATA_DISK_SIZE})"
  [[ -w /dev/kvm ]] || fail "/dev/kvm is not usable: the VM tests need hardware virtualization"
  qemu-system-x86_64 -enable-kvm -m "$VM_MEMORY" -smp "$VM_CPUS" \
    -drive "file=$VM_DIR/system.qcow2,if=none,id=system,format=qcow2" \
    -device virtio-blk-pci,drive=system,bootindex=0 \
    -drive "file=$VM_DIR/seed.iso,if=virtio,format=raw,readonly=on" \
    "${disks[@]}" \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${VM_SSH_PORT}-:22" \
    -display none -serial "file:$VM_DIR/console.log" \
    >"$VM_DIR/qemu.log" 2>&1 &
  echo $! > "$VM_DIR/qemu.pid"
  sleep 5
  kill -0 "$(cat "$VM_DIR/qemu.pid")" 2>/dev/null || { cat "$VM_DIR/qemu.log"; fail "QEMU exited"; }
  vm_wait_ssh 600
}

vm_reboot() {
  log "Rebooting the VM"
  vm_ssh 'systemctl reboot' || true
  sleep 10
  vm_wait_ssh 300
}

vm_stop() {
  [[ -f "$VM_DIR/qemu.pid" ]] && kill "$(cat "$VM_DIR/qemu.pid")" 2>/dev/null || true
}
