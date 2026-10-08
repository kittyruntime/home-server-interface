---
title: Backup and restore the configuration
description: What a configuration backup holds, how to restore it on a fresh installation, and what to do afterwards.
---

A configuration backup lets you rebuild your HSI server after a reinstall or on a
new system disk. It holds the configuration, not your files: data on the volumes
stays on the disks, and app data stays in the app volumes.

## What a backup holds

Settings > Backup & restore > Export writes one encrypted file
(`hsi-config-<date>.hsibak`), protected by a password of at least 16 characters.
HSI cannot recover it without that password.

| Included | Not included |
|---|---|
| Accounts, groups, permissions, Places, shares, settings, notification connectors, metrics and audit history (the database) | Files on the volumes and in Places |
| The key that encrypts the connectors' secrets | Docker volumes and app data |
| The Linux account and group ids of each HSI account | Samba passwords |
| Each app's definition (`compose.yaml` and its configuration files) | Disks, arrays and volumes themselves |
| The [storage descriptions](/home-server-interface/guide/storage-descriptions/) of the volumes | The server's own secrets (sessions, message bus) |
| The schedule of disk checks | |

Backups made before HSI 1.65 hold the database only; they still restore.

## Restore on a fresh installation

1. Install HSI and create the administrator with the setup link.
2. Connect the data disks.
3. In Settings > Backup & restore, choose the backup file, type its password,
   then **Check the backup**. HSI decrypts it and shows:
   - where and when it was made, and what it holds;
   - **conflicts**, which block the restore: a Linux account id from the backup
     is already used by another account on this server (or an account exists
     with other ids). Each conflict comes with the command to solve it on the
     server, for example `sudo usermod -u 1050 bob`. Solve them, then check the
     backup again;
   - **warnings**: an app that exists here with other files (it is kept aside as
     `<app>.before-restore-<date>`), a volume whose disks are not connected, a
     Place folder that does not exist yet.
4. **Restore…** recreates the Linux accounts with their ids, the apps (stopped)
   and the volume descriptions, replaces the database, then restarts HSI.

A backup made by a newer HSI than the one installed is refused: update HSI first.

## After the restore

Settings > Backup & restore lists what is left to do:

- **Volumes**: each described volume shows on the Volumes page with **Reapply**,
  which reassembles its array, activates its volume group, restores its fstab
  entry and mounts it. Nothing is formatted.
- **Apps**: start them from Apps once their volumes are back.
- **Samba passwords**: they are not in the backup. Each account sets a new
  password in its profile (or an administrator resets it in Users) before it can
  open the shares.

The previous database is kept on the server as a rollback copy
(`hsi.db.pre-restore-<date>`).
