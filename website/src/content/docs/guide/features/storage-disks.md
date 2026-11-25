---
title: Disks
description: The Disks tab of Storage, its bays, colors, health and free disks.
sidebar:
  label: 'Storage: Disks'
  order: 1.1
---

The **Disks** tab shows every disk of the server as a bay of a chassis. A bay's
color says what uses the disk:

- **Solid colored border**: a volume. LVM volumes (directly or through a RAID array) take the theme's color, ZFS pools a violet of their own; the legend under the bays names them.
- **Dashed grey**: a free disk, ready for a new volume.
- **Neutral**: the system disk, or a disk HSI does not manage.

Each bay shows the disk's name, size, temperature and a health dot from its
[S.M.A.R.T.](/home-server-interface/guide/features/storage-glossary/#smart) data:
green when the last check passed, orange when an attribute needs watching, red when
the disk reports a failure. Select a free disk to create a volume on it.

The list under the bays has every detail:

Each disk shows its stable `/dev/disk/by-id` name next to the kernel name
(`/dev/sdb`), its S.M.A.R.T. health and temperature, and the volumes it carries.
A disk can be given a label ("bay 3, top") that follows it by serial number.
Partitions and formatting are available on free disks; disks used by an array or
a volume group are read-only in the UI.

