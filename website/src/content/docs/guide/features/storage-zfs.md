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

## Create a pool

**Pools > Create a pool** builds a pool from free whole disks: its name (it is
mounted on `/srv/<name>`), its layout, its disks and its compression (lz4 by
default). The dialog says how much space the pool holds and how many failed disks
it survives: a **stripe** uses every disk with no redundancy, a **mirror** keeps a
full copy on each disk, **RAID-Z1**, **Z2** and **Z3** survive one, two or three
failed disks (3, 4 and 5 disks or more). The plan lists every disk it erases. HSI
watches the pools it creates.

A pool's page has **New dataset** (inside the pool or another dataset, with an
optional quota and its compression) and **Delete the pool**: every dataset and
file is destroyed and its disks are erased, so they show as free again. Under
**Datasets**, **Edit** changes a dataset's quota and compression and **Delete**
destroys it (delete the datasets inside it first). A pool or a dataset used by a
Place, a share or an app cannot be deleted until nothing uses it; deleting asks
you to type its name.

## Datasets are volumes

A dataset ZFS mounts on a folder of its own is a volume like any other: Places,
shares, apps and data backups use it. Its redundancy comes from its pool (a
mirror, [raidz](/home-server-interface/guide/features/storage-glossary/#raidz)1,
2 or 3, or no redundancy for disks striped together). Datasets with the mount
point `none` or `legacy`, and container datasets (`canmount=off` or `noauto`),
are listed under **Datasets** but are not volumes.

## Watched pools

HSI watches the pools it imported, and the pools you choose to watch (**Watch
this pool**). The datasets of a watched pool are guarded like any HSI volume: if
the pool is missing at boot, or a dataset is not mounted, the apps using it stop,
its shares become unavailable and writes are refused until it is back and you
resume. A pool you import or export by hand is never held unless you watch it.
A dataset is held on the second check that finds it missing, so a pool slow to
import at boot does not stop anything. The list is kept in
`/etc/hsi/zfs-pools.json`.

A watched pool that is gone (destroyed, or its disks removed for good) stays
listed under **Pools** as missing, with **Stop watching** to release its holds.
The ZFS tab stays while a pool is watched, even when the ZFS module did not load
after a kernel update. If the units that import and mount pools at boot
(`zfs-import-cache`, `zfs-mount`) are disabled, Pools says so.

## Import a pool

**Import** lists the pools found on the disks but not imported: disks moved from
another machine, or after a reinstall. Importing changes no data. HSI imports the
pool without mounting anything, then mounts its datasets only in the data
folders (`/srv`, `/mnt`, `/media`, or `/<pool name>`), through folders owned by
root, never over or inside a folder already in use (another volume), with setuid
programs, device files and the pool's own NFS and SMB sharing turned off. Every
dataset is checked, including those mounted only by hand (`canmount=noauto`). If
one would mount elsewhere, or anything cannot be checked, the pool is exported
again and nothing is mounted: import it by hand with `zpool import -N`, change
its mount points with `zfs set mountpoint=...`, export it, then import it in HSI.
A child dataset whose parent folder belongs to a user is refused for the same
reason.

A pool last used by another system is marked as such: **Import anyway** imports
it (`zpool import -f`). Do it only when that system no longer uses the disks.

On a server with less than 2 GB of memory, the import warns that ZFS keeps a
cache in memory ([ARC](/home-server-interface/guide/features/storage-glossary/#arc))
that competes with HSI and the apps.

## Alerts

Monitor raises an alert when a pool is degraded (warning) or faulted or
unavailable (critical), when a disk of a pool reports read, write or checksum
errors, and when the last scrub found errors. Each alert closes once the pool is
healthy again or no longer imported.

## Coming next

Scheduled scrubs, replacing a disk, snapshots and growing a pool arrive in the
next releases.
