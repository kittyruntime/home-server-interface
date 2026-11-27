---
title: LVM volumes
description: LVM and mdadm in Storage: arrays and volume groups in Pools, their volumes and mounts.
sidebar:
  label: 'Storage: LVM'
  order: 1.2
---

`mdadm` arrays and LVM volume groups are pools (Storage > Pools, with the type
badge `mdadm` or `LVM`); the volumes HSI builds on them are in Storage > Volumes. Each volume shows how it is built, from the disks to
its folder:

disks -> [array](/home-server-interface/guide/features/storage-glossary/#array) ->
[volume group](/home-server-interface/guide/features/storage-glossary/#volume-group) ->
[filesystem](/home-server-interface/guide/features/storage-glossary/#filesystem) ->
mount point

A volume on a single disk (a USB disk, for example) has no array and no volume
group, and is marked as such.

## Partitions & formatting

This part of Storage > Disks lists the disks no array, volume group, ZFS pool or the system uses,
with the tools to create a partition table, add or delete partitions, format,
mount and unmount. Disks in use are left out, so nothing in use can be erased
from here.

To learn more about the tools themselves: [LVM2](https://sourceware.org/lvm2/),
the [lvm(8) manual](https://man7.org/linux/man-pages/man8/lvm.8.html) and the
[Linux RAID documentation](https://docs.kernel.org/admin-guide/md.html).

## Volumes

Each data filesystem is listed with its redundancy (mirror, RAID 5...), space,
health (degraded or rebuilding array, missing at boot, nearly full, SMART) and
what uses it (Places, shares, apps), next to the free disks and the system disk's
free space. Each volume has its own page with Overview, Structure and Activity
tabs: what it is made of from the folder down to the disks, and the operations
recorded on it.

- **Create a volume**: Storage > Volumes > Create volume goes from free disks to a
  ready-to-use volume in one flow: choose the disks, the redundancy (mirror,
  RAID 5, 6, 10, or none), the LVM layout, the filesystem label and the folder,
  who owns it, and, for admins, a Place and an SMB share.
- **Expand a volume**: from a volume's page (Expand...), grow it in place without
  reformatting: into the free space of its volume group, with a disk added to its
  RAID 5/6 array or to a volume without redundancy, or into the larger disks of
  its mirror. A RAID reshape takes hours: the volume stays usable, and HSI grows
  LVM and the filesystem (ext4, XFS, btrfs) when it ends, then sends a
  notification with the new size.
- **Remove a volume**: Overview > Remove this volume stops sharing its Places,
  unmounts it, deletes its logical volume (and its volume group and array when
  they serve only this volume), then erases the disks so they show as free again.
  Remove stays disabled until the volume name is typed; a volume an app stores
  data on cannot be removed.
- **Mount**: an unmounted volume can be mounted from its page in Volumes, with its
  owner, an optional Place, and "Persist across reboots" (an `/etc/fstab` entry).

## Arrays and volume groups

Each RAID array and LVM volume group has its own page: state, members, what it
carries and its operations.

- **Replace a failed disk**: members are listed as Active, Rebuilding, Failed or
  Spare with their model and serial number. Mark a disk as failed, remove it and
  add a replacement (only free disks large enough are offered); rebuild progress
  is shown live.
- **Import existing storage**: arrays and volume groups found on the disks but
  not running (disks moved from another machine, or after a reinstall) are
  listed and can be assembled or activated without formatting.

