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
change to the Samba configuration as a diff before it runs. The Diagnostics tab
shows, per share, who can actually read and write, and who is blocked and why.

## Without HSI

See [Samba](/home-server-interface/guide/manage-without-hsi/#samba-smb-shares) and
[Users](/home-server-interface/guide/manage-without-hsi/#users-linuxsamba-identity).
