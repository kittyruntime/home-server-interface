---
title: Maintenance and backups
description: Scheduled disk checks, SMART self-test results, configuration backups and data backup plans.
sidebar:
  order: 6
  badge: Beta
---

## Scheduled disk checks

Storage > Maintenance schedules SMART short and extended self-tests and RAID
consistency checks. A systemd timer runs them even when the dashboard is down.

- A check whose time slot was missed (server off or asleep) runs at the next
  hourly tick.
- Sleeping disks are not woken up, and no check starts while an array rebuilds:
  the check is retried every hour, and the page says why it did not run.
- Each disk's self-test shows as Running (with what is left), then Passed or
  Failed. Disks that cannot run SMART self-tests are listed as skipped.
- A RAID mismatch raises an alert.

## Configuration backup

Settings > Backup & restore exports the HSI configuration, encrypted with
AES-256-GCM and a password-derived key: the database, the account ids, the app
definitions and the volume descriptions. A restore shows a preview first and
stops on account id conflicts. Files in Places and Docker volume contents are not
part of it. See [Backup and restore the configuration](/home-server-interface/guide/backup-restore/).

## Data backups

The Backups page runs two kinds of plans, each from its own systemd timer, so they
run even when the HSI server is down:

- **Sync** plans copy a folder with rsync, locally or over SSH, as a mirror.
- **Versions** plans take encrypted snapshots with restic into a repository (a
  folder, an SFTP server, S3-compatible storage or a restic REST server), keep the
  history you choose and let you restore a file or a folder from any snapshot.

A failed run or a failed repository check raises an alert. See
[Backups of your data](/home-server-interface/guide/data-backups/).
