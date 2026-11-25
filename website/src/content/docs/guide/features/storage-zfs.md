---
title: ZFS
description: ZFS pools and datasets in Storage, when the server has ZFS.
sidebar:
  label: 'Storage: ZFS'
  order: 1.25
---

HSI uses ZFS when the server already has it. It never installs it: the ZFS tab
appears once the `zfs` kernel module is loaded and the `zpool` and `zfs` commands
are installed. Without ZFS, Storage looks the same as before.

To install ZFS, follow the [OpenZFS getting started guide](https://openzfs.github.io/openzfs-docs/Getting%20Started/index.html)
for your distribution. On Ubuntu the module comes with the kernel (`zfsutils-linux`);
on Debian and Raspberry Pi OS it is built for your kernel (`zfs-dkms`, from
`contrib`), which takes a few minutes. Reboot or load the module, then open
Storage again.

## Pools

The **Pools** section lists the pools imported on the server: their state,
capacity,
layout drawn as a tree (the pool, its [vdevs](/home-server-interface/guide/features/storage-glossary/#vdev),
their disks, with read, write and checksum errors), and the last
[scrub](/home-server-interface/guide/features/storage-glossary/#scrub) or
[resilver](/home-server-interface/guide/features/storage-glossary/#resilver).
The Disks tab colors the disks of a pool with their own color.

## Datasets are volumes

A dataset ZFS mounts on a folder of its own is a volume like any other: Places,
shares, apps and data backups use it. Its redundancy comes from its pool (a
mirror, [raidz](/home-server-interface/guide/features/storage-glossary/#raidz)1,
2 or 3, or no redundancy for disks striped together). Datasets with the mount
point `none` or `legacy` are listed under **Datasets** but are not volumes.

## Watched pools

HSI watches the pools it imported, and the pools you choose to watch (**Watch
this pool**). The datasets of a watched pool are guarded like any HSI volume: if
the pool is missing at boot, or a dataset is not mounted, the apps using it stop,
its shares become unavailable and writes are refused until it is back and you
resume. A pool you import or export by hand is never held unless you watch it.
The list is kept in `/etc/hsi/zfs-pools.json`.

## Import a pool

**Import** lists the pools found on the disks but not imported: disks moved from
another machine, or after a reinstall. Importing changes no data. HSI imports the
pool without mounting anything, then mounts its datasets only in the data
folders (`/srv`, `/mnt`, `/media`, or `/<pool name>`), through folders owned by
root, never over a folder already in use, with setuid programs and device files
turned off. If a dataset would mount elsewhere, the pool is exported again and
nothing is mounted: import it by hand with `zpool import -N`, change its mount
points with `zfs set mountpoint=...`, export it, then import it in HSI.

On a server with less than 2 GB of memory, the import warns that ZFS keeps a
cache in memory ([ARC](/home-server-interface/guide/features/storage-glossary/#arc))
that competes with HSI and the apps.

## Alerts

Monitor raises an alert when a pool is degraded (warning) or faulted or
unavailable (critical), when a disk of a pool reports read, write or checksum
errors, and when the last scrub found errors.

## Coming next

Creating pools and datasets, scheduled scrubs, replacing a disk, snapshots and
growing a pool arrive in the next releases.
