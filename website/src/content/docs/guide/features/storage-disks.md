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

The list under the bays shows each disk as hardware: its name and label, model
and serial number, size, type, SMART health and temperature, and **Used by**:
the array, volume group or ZFS pool built on it, as a link to its page, or Free,
System. A filter shows only the disks of one use. Select a disk to open its page:
identity, SMART details, self-tests and its label.

Partitioning, formatting and mounting are not in this tab: they are in
**LVM > Partitions & formatting**, which lists only the disks nothing uses. See
[LVM volumes](/home-server-interface/guide/features/storage-lvm/).
