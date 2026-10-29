# VM tests

`scripts/vm/suite.sh` installs and updates HSI on a disposable QEMU/KVM virtual
machine: the Debian 13 cloud image with an overlay system disk and four blank
data disks, reached over SSH on a forwarded port. Nothing touches the host's own
disks; the VM and its disks are deleted with `$VM_DIR`.

| Scenario | What it checks |
| --- | --- |
| `fresh` | Install of the built archive, services and health, migration ledger, data kept across a reboot, a broken update (a server that exits at once) refused and rolled back with the data intact |
| `storage` | A mirrored volume (RAID 1, LVM, filesystem, Place, SMB share) created through the API as an administrator, then checked on the host (`mdadm`, `mdadm.conf`, `lvs`, `findmnt`, `/etc/fstab`, `testparm`) before and after a reboot |
| `network` | NetworkManager takes over the VM's interface; manual addressing applied through the API and kept; then a wrong address applied without keeping it: SSH drops and NetworkManager restores the previous settings by itself |
| `update` | Install of the latest published release, data added, update to the built archive, `hsi-worker update rollback` back to the published release, update again; data and ledger checked at each step |

The `VM tests` workflow builds a pre-release archive (`<next patch>-vmtest.<run>`)
and runs both scenarios in parallel: on demand, every Monday, and on pull requests
that touch the installer, the database package, the root worker or the runtime.
Logs (install, rollback, console, `hsi-server` journal) are kept as artifacts.

Run it locally on a Linux host with KVM, QEMU and `cloud-image-utils`:

```sh
scripts/package-release.sh 1.71.1-dev   # after building like the workflow does
VM_DIR=$(mktemp -d) scripts/vm/suite.sh fresh hsi-v1.71.1-dev-linux-amd64.tar.gz 1.71.1-dev
```
