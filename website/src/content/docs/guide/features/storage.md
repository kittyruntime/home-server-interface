---
title: Storage
description: Disks, RAID arrays, LVM and volumes, from free disks to a mounted, shared folder.
sidebar:
  order: 1
  badge: Beta
---

The Storage app manages the server's real disks: S.M.A.R.T. health, `mdadm` RAID,
LVM, ZFS and mounts. Its menus follow what you do, not the technology: `mdadm`,
LVM and ZFS are types, shown as a badge on each pool and volume, and their own
actions are on the page of each object.

disks -> partitions (optional) -> pools (optional) -> volumes -> filesystems -> mount points

- **Overview**: usable capacity, disk health, what is in progress, counts from
  the disks to the mounts, capacity by pool and what needs attention.
- **Disks**: every disk, drawn as the bays of a chassis and colored by what uses
  it, then partitioning and formatting of the disks nothing uses. See
  [Disks](/home-server-interface/guide/features/storage-disks/).
- **Pools**: `mdadm` arrays, LVM volume groups and ZFS pools in one list, with
  what each sits on and holds (a volume group can sit on an array). **Create a
  pool** starts with the type; **Import** gathers the pools found on the disks.
  See [LVM volumes](/home-server-interface/guide/features/storage-lvm/) and
  [ZFS](/home-server-interface/guide/features/storage-zfs/).
- **Volumes**: every volume with its type, and the ZFS dataset settings.
- **Mounts**: where each filesystem appears, and whether it comes back at boot.
- **Snapshots**, on a server with ZFS.
- **Maintenance**: what is in progress, then the scheduled SMART self-tests, RAID
  checks and ZFS scrubs. See [Maintenance](/home-server-interface/guide/features/maintenance/).

Storage opens on the Overview. A single disk can hold a volume with no pool.
Technical terms have a help icon that leads to the
[glossary](/home-server-interface/guide/features/storage-glossary/).

![Storage, with its volumes, arrays and disks](../../../../assets/storage.png)

## Descriptions and drift

Each volume is described in `/etc/hsi/storage/`, readable without HSI: its disks by
serial number, its array, LVM, filesystem and mount. When the server no longer
matches it (a disk swapped by hand, an fstab line removed, an array stopped), the
volume's page says what differs, with **Reapply** to put the server back in line
and **Accept current state** to keep the change. See
[Storage descriptions](/home-server-interface/guide/storage-descriptions/).

## Every change is a plan

Formatting, partitions, arrays, LVM and mounts are shown as a plan before
anything runs: every command, every file change as a diff, and the disks that
will be erased with their model and serial number. See
[Plans and missing volumes](/home-server-interface/reference/storage-plans/).

## Without HSI

Arrays, volume groups and mounts are standard `mdadm`, LVM and `/etc/fstab`
configuration: see [RAID](/home-server-interface/guide/manage-without-hsi/#raid-mdadm) and
[Mounts](/home-server-interface/guide/manage-without-hsi/#mounts).
