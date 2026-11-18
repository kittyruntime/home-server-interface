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
change to the Samba configuration as a diff before it runs.

The Sharing app has four sections:

- **Shared folders**: a table of every share (location, protocols, access,
  state, people connected) with a toolbar to create, edit, enable, disable or
  delete the selected one. Below it, the selected share's detail in three tabs:
  **Connect** (addresses for Windows, macOS and Linux, NFS mount commands, the
  SFTP address), **Access** (who can read and write, and its checks) and
  **Activity** (who is connected over each protocol, and recent SMB activity).
  The share editor has a tab per protocol: General, SMB, NFS and SFTP.
- **File services**: one card per protocol with its state. SMB's card holds
  its settings (network name, workgroup, discovery, oldest protocol,
  encryption) and starts or restarts Samba.
- **Security**: automatic blocking of addresses after failed sign-ins, and the
  addresses blocked now.
- **Journal**: SMB connections and refusals of the last 30 days.

### Time Machine

A share can be a **Time Machine destination**, with an optional size limit in GB
(Time Machine removes its oldest backups to stay under it). It needs Samba's
`fruit` and `streams_xattr` modules, which most distributions ship with Samba.
With macOS discovery turned on in File services, SMB (Avahi installed), the share
appears in Time Machine's list of disks; otherwise connect to it in the Finder
first, then choose it in System Settings, General, Time Machine.

## NFS

A share can also be exported over **NFS**, for Linux machines, hypervisors
(Proxmox, VMware) and media players. NFS has no password: list the machines
allowed to mount it (addresses or networks like `192.168.1.0/24`; every address
at once is refused). Every NFS client writes as one account you choose among
those who may write to the Place, so files stay usable over SMB and in HSI;
with nobody chosen, the export is read-only. A share can be NFS only.

HSI writes its exports to `/etc/exports.d/hsi.exports` and never edits
`/etc/exports`. It needs the NFS server (`nfs-kernel-server` on Debian and
Ubuntu, `nfs-utils` elsewhere). From Linux: `sudo mount -t nfs <nas>:<path> /mnt/<name>`;
from macOS, `nfs://<nas><path>` in the Finder's Connect to Server.

## SFTP

A share can also be reached over **SFTP**, with each person's HSI username and
password, from FileZilla, Cyberduck, WinSCP or a phone's file app, on the
server's SSH port: `sftp://<username>@<nas>/<share>`. HSI uses the host's
OpenSSH: it adds its own `/etc/ssh/sshd_config.d/hsi-sftp.conf` (checked with
`sshd -t` before any reload) and never edits `sshd_config`. Each person is
locked in a folder that shows only the shares they can read, read-only where
they cannot write, and gets no shell. Only the accounts HSI created get SFTP:
an account with a login shell keeps its own SSH access, unchanged. It needs
`openssh-server` and a `sshd_config` that includes `sshd_config.d` (the
default on Debian, Ubuntu and Fedora).

For NFS and SFTP, a share's folder must be a real folder whose parent folders
belong to root and are writable by nobody else: otherwise someone could swap
it for a link to elsewhere. A Place inside another Place is therefore not
exported over NFS nor shown over SFTP (SMB is not affected).

## Without HSI

See [Samba](/home-server-interface/guide/manage-without-hsi/#samba-smb-shares) and
[Users](/home-server-interface/guide/manage-without-hsi/#users-linuxsamba-identity).
