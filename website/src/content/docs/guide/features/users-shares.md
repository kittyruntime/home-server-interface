---
title: Users and shares
description: Users, groups, permissions, delegated administration and SMB sharing.
sidebar:
  order: 4
  badge: Beta
---

HSI is multi-user from the start.

- **Users and groups**: an account's username is also its Linux and Samba
  account, so SMB sharing works without extra setup. Each user can opt out of a
  Samba account.
- **Administrators** have full access to every Place and manage apps, users and
  settings. Storage administration can be delegated to a non-admin account.
- **Permissions** are granted per Place, to users or groups: Read, Write, Delete
  and Share. Changes take effect immediately.
- **Sign-in protection**: after 5 failed sign-ins for a username (or from one IP
  address) within 15 minutes, further attempts are blocked until the window
  expires.
- **Audit log**: privileged actions are recorded with their parameters, secret
  values redacted.

## SMB shares

Sharing publishes Places over SMB with Samba, in sync with HSI's accounts and
permissions. Creating, editing, enabling, disabling and removing a share show the
change to the Samba configuration as a diff before it runs. Each share's detail
shows how to connect from Windows, macOS and Linux, who can read and write, who
is connected now, its recent activity and its checks.

### Time Machine

A share can be a **Time Machine destination**, with an optional size limit in GB
(Time Machine removes its oldest backups to stay under it). It needs Samba's
`fruit` and `streams_xattr` modules, which most distributions ship with Samba.
With macOS discovery turned on in the SMB settings (Avahi installed), the share
appears in Time Machine's list of disks; otherwise connect to it in the Finder
first, then choose it in System Settings, General, Time Machine.

## Without HSI

See [Samba](/home-server-interface/guide/manage-without-hsi/#samba-smb-shares) and
[Users](/home-server-interface/guide/manage-without-hsi/#users-linuxsamba-identity).
