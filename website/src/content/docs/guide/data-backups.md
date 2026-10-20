---
title: Backups of your data
description: Sync and versioned backup plans, the four repository types, the repository password, retention, restoring files and recovering on a new server.
---

The Backups page schedules copies of your files to another disk, another server or
cloud storage. A plan is one of two kinds. This page covers both; the backup of
HSI's own configuration is a separate feature, described in
[Backup and restore the configuration](/home-server-interface/guide/backup-restore/).

## Sync or versions

| Kind | What it does | Keeps history |
|---|---|---|
| Sync | Copies the source to a destination with rsync, locally or over SSH. | No: the destination mirrors the source |
| Versions | Takes encrypted, deduplicated snapshots into a repository with restic. | Yes: you choose how many snapshots to keep |

A sync copy repeats mistakes: a file deleted or overwritten by accident disappears
from the destination at the next run. Use versions when you want to go back in time.

## Repositories

A versioned plan writes to a repository, which you create once on the Backups page
and reuse for several plans. Four types are available:

| Type | What it needs |
|---|---|
| Local | A folder on this server, ideally on another disk than the data you back up. |
| SFTP | Host, port, user, a folder on the remote server and the path of a private SSH key on this server. |
| S3-compatible | Endpoint, bucket, access key and secret key (Amazon S3, MinIO, Backblaze B2 and similar). |
| REST server | The URL of a [restic REST server](https://github.com/restic/rest-server), with its user and password when it has one. |

### SFTP and the host key

The backups run as root, so SFTP uses root's `known_hosts` and refuses a host it
does not know (`StrictHostKeyChecking=yes`). Connect once as root to accept the
host key:

```bash
sudo ssh -i /root/.ssh/backup_key user@backup-host
```

The key path must be absolute and made only of letters, digits, `.`, `_`, `-` and
`/`.

## The repository password

A repository is encrypted. HSI generates its password when you create it and shows
it once: store it in your password manager right away. Without it, the backups
cannot be read, by HSI or by anyone else. You can display it again from the
repository after re-entering your account password.

The password is also kept in the
[configuration backup](/home-server-interface/guide/backup-restore/), so restoring
that backup on a new server gives you access to your repositories again.

To attach a repository that already exists (made by HSI on another server or by
restic), choose to attach it and enter its password.

## Retention

Each plan keeps the last N snapshots and, optionally, one per day, week and month.
The rules apply after each snapshot and only to the snapshots of that plan, so two
plans sharing a repository never prune each other's history. Anything not matched by
a rule is removed (pruned).

## Apps and consistent snapshots

Files of a running database are not safe to copy. Tick the apps whose data the plan
covers: HSI stops them before the snapshot and starts them again right after it,
before old snapshots are pruned, so downtime lasts only as long as the snapshot.

If an app could not be stopped, the snapshot is still taken but is marked
**inconsistent** in the list: it may restore correctly, but nothing guarantees it.

## Integrity checks

Each repository has its own check timer: weekly by default, reading 5% of the data
each time, so the whole repository is verified over a few months. A failed check
raises an alert. You can also start a full check by hand from the repository, which
reads everything and can take a long time on large repositories.

## Restore

Open a snapshot to browse it, then restore a file or a folder.

- **To a new folder** (default): the files go into
  `<volume>/Restored/<repository>-<date>/`, with a `-2` suffix if that folder
  already exists. Nothing existing is touched.
- **Over the original location**: only after an explicit confirmation. A restore
  never deletes files: it writes the files of the snapshot and leaves the others in
  place.

Ownership, permissions, ACLs and extended attributes are restored with the files.
What the destination refuses to hold (a file system without ACLs, for example) is
listed after the restore.

Before you restore over the original location, look at the destination: any member
of a share can rename the top-level folders of a volume (volumes have no sticky
bit), so a path that looks right may not be the folder you think it is.

## Recovering on a new server

1. Install HSI and connect the disks.
2. Restore the [configuration backup](/home-server-interface/guide/backup-restore/)
   first: it carries the repository secrets, so your repositories and plans come back
   as they were.
3. Or, without a configuration backup, create a repository of the same type on the
   Backups page, attach the existing repository with its password, then restore from
   its snapshots.

## Scheduling

Each plan has its own systemd timer, and each repository its own check timer, so
backups run even when the HSI server is down. See [Manage without
HSI](/home-server-interface/guide/manage-without-hsi/) for the commands. Plans made
with an earlier version of HSI (rsync) were moved to this page and to timers when you
updated.

## About restic

HSI uses [restic](https://restic.net) 0.19.1. The installer downloads it from the
official GitHub release, checks its SHA-256 checksum and installs it at
`/usr/local/lib/hsi/restic`. HSI never uses a restic installed by your
distribution. If the download fails, versioned plans stay unavailable until you
run the installer again.
