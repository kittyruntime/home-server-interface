---
title: Storage descriptions
description: The file that describes each volume HSI manages, how HSI shows when the server no longer matches it, and how to reassemble a volume by hand from it.
---

Every volume HSI manages has a description in `/etc/hsi/storage/`: which disks it
is made of, how its array and LVM are set up, its filesystem and where it is
mounted. It is a plain YAML file, readable without HSI, and enough to bring the
volume back by hand.

## The file

The file is named after the mount point: `/srv/data` is described in
`/etc/hsi/storage/srv-data.yaml`.

```yaml
# Written by HSI after each storage change it applies to this volume.
# Reassemble and mount it by hand:
# https://kittyruntime.github.io/home-server-interface/guide/storage-descriptions/
version: 1
updated: 2026-10-06T14:00:00.123456789Z
mount:
  point: /srv/data
  options: defaults,nofail,x-systemd.device-timeout=10s
filesystem:
  type: ext4
  uuid: 5f1c2d3e-0000-4000-8000-000000000001
  label: data
lvm:
  vg: data
  lv: data
array:
  name: md0
  level: raid5
  metadata: "1.2"
  uuid: a1b2c3d4:11111111:22222222:33333333
  devices: 3
disks:
  - byId: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-AAA
    serial: WD-AAA
    size: 4000787030016
    role: active
  - byId: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-BBB
    serial: WD-BBB
    size: 4000787030016
    role: active
  - byId: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-CCC
    serial: WD-CCC
    size: 4000787030016
    role: active
```

| Field | Meaning |
|---|---|
| `mount` | Where the volume is mounted and its mount options, as in `/etc/fstab`. |
| `filesystem` | Type, UUID and label of the filesystem. The UUID is what fstab and `mount` use. |
| `lvm` | The volume group and logical volume, when the filesystem is on LVM. A volume group over several disks lists them under `pvs`. |
| `array` | The `mdadm` array, when there is one: its name when it was described, level, metadata version, UUID and number of members. Arrays are recognized by UUID: their name can change at boot. |
| `disks` | Each disk by its stable `/dev/disk/by-id` path (`/dev/disk/by-path` for a disk without one, such as some virtual disks) and serial number (printed on the disk's label), with its size and its role: `active` or `spare` in an array, `data` otherwise. `partition` is set when a partition is used rather than the whole disk. |

## When HSI writes it

HSI rewrites a volume's description after each storage change it applies to that
volume: creating, mounting with "Persist across reboots", expanding (again when a
reshape ends), and adding, failing or removing an array member. Removing the
volume, or unmounting it and removing it from fstab, deletes the file. A volume
that has no description yet gets one within a minute of being mounted.

The file therefore records the last state you approved in HSI. Nothing else
rewrites it: a change made by hand shows as a difference instead of being
recorded silently. The mount options are only taken from fstab when HSI mounts
the volume: an array or expand operation keeps the described ones, so an fstab
edit stays a difference until you accept it.

A description edited by hand into a file HSI cannot read is reported as such on
the volume; Accept current state writes it again.

## Differences

HSI compares each description with the server. When they differ, the volume's
page shows "Differs from its description" with what changed, and a warning alert
is raised. For example:

- `/srv/data is not mounted` (a volume that is simply unmounted, with nothing else
  different, is not reported: the Volumes page offers to mount it)
- `The fstab entry for /srv/data is missing`
- `Array a1b2c3d4:... (md0) is not running`
- `mdadm.conf has no ARRAY line for md0`
- `Disk WD-BBB is not connected`
- `Disk WD-DDD is in md0 but not in the description`

HSI never corrects anything on its own. Two actions are offered, each shown as a
plan before it runs:

- **Reapply** puts the server back in line with the description: it restores
  the `ARRAY` line in `mdadm.conf` (and refreshes the initramfs), assembles the
  array from its described disks, activates the volume group, restores the fstab
  entry and mounts the volume. Only the steps that are needed are listed. It
  never creates, formats, erases or adds anything. If a disk is missing, it can
  start the array without it, after you confirm it has no redundancy left. It
  does not change array members: for that, use the array's page.
- **Accept current state** rewrites the description from the server, after
  showing the changes. Use it after a change you made on purpose.

From a shell, `hsi-worker storage diff` prints the differences of every volume.

## Reassemble by hand

Without HSI, the description is enough to bring the volume back. With the example
above:

```bash
# 1. Assemble the array from its disks (add --run if one is missing)
mdadm --assemble /dev/md0 --uuid=a1b2c3d4:11111111:22222222:33333333 \
  /dev/disk/by-id/ata-WDC_WD40EFRX_WD-AAA \
  /dev/disk/by-id/ata-WDC_WD40EFRX_WD-BBB \
  /dev/disk/by-id/ata-WDC_WD40EFRX_WD-CCC

# 2. Activate the volume group
vgchange -ay data

# 3. Mount the filesystem
mkdir -p /srv/data
mount -o defaults,nofail UUID=5f1c2d3e-0000-4000-8000-000000000001 /srv/data
```

To keep it at boot:

```bash
# fstab line, with the marker HSI looks for (check that /etc/fstab does not
# already have an entry for /srv/data before adding it)
printf '%s\n' '# HSI-managed mount: /srv/data' \
  'UUID=5f1c2d3e-0000-4000-8000-000000000001 /srv/data ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2' >> /etc/fstab

# keep the array name at boot
mdadm --detail --brief /dev/md0 >> /etc/mdadm/mdadm.conf
update-initramfs -u
```

Without an array, skip step 1. Without LVM, skip step 2. See
[Manage without HSI](/home-server-interface/guide/manage-without-hsi/) for the
rest of what HSI manages.
