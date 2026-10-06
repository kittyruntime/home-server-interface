---
title: Plans and missing volumes
description: How HSI previews every change before it runs, and protects volumes whose disk is missing.
---

Every change HSI makes to the server is shown as a plan before it runs, and volumes it mounts are protected when their disk goes missing.

## Previewing operations

Formatting, partition changes, RAID creation and deletion, LVM changes and
mounts are shown as a plan before anything runs: every command with its exact
arguments, every file change as a diff (`/etc/fstab`, `mdadm.conf`), and, for
steps that erase data, the device with its model, serial number, size and
current contents. Applying runs exactly that plan. If the server changed in
between (fstab edited, another disk behind the same name), HSI refuses and asks
you to review the new plan. The executed plan, with the result of each step, is
kept in the audit log.

From a shell, `hsi-worker plan preview <op> '<json>'` prints the same plan (and
`hsi-worker plan apply <op> '<json>' <fingerprint>` applies it).

### Apps

Saving an app (from the form or the compose file editor), applying, starting,
installing from the App Store and deleting are previewed the same way: the
`compose.yaml` content or its diff, the folders and Places an install creates,
and the `docker compose` commands. Values of environment variables whose name
looks secret (password, token, key...) are masked in the preview and in the
audit log; the written file keeps them. If `compose.yaml` changed since the
preview, HSI refuses and asks you to review again. Commands that start
containers run in the background; follow them in the notifications. After an
App Store install, HSI opens Apps on the new app and its logs.

### Shares

Creating, editing, enabling, disabling and removing an SMB share (Sharing)
show the change to `/etc/nasui/samba/smb.conf` as a diff, the systemd drop-in
that points smbd at that file when it is installed for the first time, and the
`systemctl` commands that reload smbd. If `smb.conf` changed in between (a
permission change or a missing volume also rewrites it), HSI refuses and asks
you to review the new plan. The share is recorded in HSI only once the plan
ran. When Samba is not installed, removing a share only removes HSI's record of
it.

### Users

Creating a user (Users) shows the commands that create its Linux account
(`useradd`, without a home directory or shell login) and set its Linux and
Samba passwords (`chpasswd`, `smbpasswd`). The password goes to those commands
on their standard input: it never appears in the plan, a command line or the
audit log. If the Linux account cannot be created, the user is not created in
HSI; a failed password step is reported as a warning.

Deleting a user shows the change to `smb.conf` (the user leaves the shares it
had access to) and its removal from the `hsi-share` group. The Linux account
and the Samba account stay on the server; see
[Managing without HSI](/home-server-interface/guide/manage-without-hsi/) to remove them.

## Missing volumes

Volumes that HSI mounts (Storage > Mounts, "Mount" with "Persist across reboots")
are protected when their disk is absent:

- The `/etc/fstab` entry carries `nofail,x-systemd.device-timeout=10s`: the
  NAS finishes booting (network and HSI included) after 10 seconds instead of
  stopping in emergency mode.
- The mount point directory is immutable (`chattr +i`) while nothing is
  mounted on it, so nothing (Docker, Samba, rsync, a script) can write to the
  system disk in the volume's place.
- HSI checks every minute. A missing, wrong or read-only volume raises a
  `storage.volume` alert and blocks what uses it: apps that bind-mount a path
  on it are stopped, its shares become unavailable, and backups, uploads and
  file writes under it are refused with the reason.
- When the right volume is back (same filesystem UUID), HSI mounts it again
  and shows it in Storage > Mounts. Nothing restarts until you click Resume.
- A volume you unmount yourself is never remounted automatically: writes
  under it are refused until you mount it again and click Resume. A volume
  mounted read-only on purpose (`ro` in its options) is not reported.

`hsi-worker volumes` prints the state of each volume from a shell. Existing
fstab entries written by HSI get the boot options at the next worker start;
very old entries without the `# HSI-managed mount:` marker are left alone.
