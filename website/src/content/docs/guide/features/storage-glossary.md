---
title: Storage glossary
description: The storage terms HSI uses, in a few sentences each.
sidebar:
  label: 'Storage: Glossary'
  order: 1.3
---

## RAID level

How an array spreads data over its disks. A mirror (RAID 1) keeps a full copy on
each disk; RAID 5 and RAID 6 spread data and parity, and survive one or two failed
disks; RAID 10 mirrors pairs of disks and stripes over them. RAID 0 has no
redundancy: one failed disk loses everything.

## Array

Several disks seen as one device by Linux (`mdadm`), with the redundancy of its
RAID level. When a disk fails the array keeps running, degraded, until the disk
is replaced and the array rebuilt.

## Volume group

The LVM layer that pools disks or arrays into one space. Volumes are cut from it,
and it can grow when a disk or an array is added.

## Logical volume

A part of a volume group, used like a disk partition but resizable. HSI puts one
filesystem on each.

## Filesystem

The format that stores files on a volume: ext4, XFS or Btrfs. It is what gets
mounted on a folder.

## SMART

The self-monitoring data every disk keeps (S.M.A.R.T.): errors, reallocated
sectors, temperature, hours of use. HSI reads it to show each disk's health and
runs scheduled self-tests. See [smartmontools](https://www.smartmontools.org/).

## RAID check

A full read of an array that compares its disks, to find silent corruption before
a disk has to be rebuilt from them.

## vdev

In ZFS, a group of disks with its own redundancy (a mirror or a raidz). A pool is
made of one or more vdevs. See the [OpenZFS documentation](https://openzfs.github.io/openzfs-docs/).

## raidz

The ZFS equivalent of RAID 5, 6 and beyond: raidz1, raidz2 and raidz3 survive one,
two or three failed disks of their vdev.

## Scrub

A ZFS check that reads every block of a pool and verifies its checksum, repairing
what it can from the redundancy.

## Resilver

What ZFS does after a disk is replaced: it rebuilds the missing data onto the new
disk, like an array rebuild.

## Snapshot

A read-only image of a ZFS dataset at one moment. It takes no space at first, then
keeps the blocks that change after it, so files can be restored as they were.

## ARC

The ZFS read cache in memory. It uses free RAM and gives it back when programs
need it; under 2 GB of RAM it competes with everything else.
