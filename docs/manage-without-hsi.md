# Manage without HSI

HSI is a control panel over standard Linux tools, not a replacement for them. For
every area below, the underlying files and commands are the same ones you'd use if
HSI weren't installed — so a stopped `hsi` service, a broken update, or a full
uninstall never leaves the server itself unmanageable.

This page intentionally doesn't cover the file manager or the App Store: browsing
files is just the filesystem (`ls`, `cp`, standard permissions), and every app the
App Store installs is a normal container, covered under Docker below.

## Docker

Containers created through the App Store or the Containers app are ordinary Docker
containers under their configured name — nothing about them depends on HSI staying
up. Each app managed by HSI is a Docker Compose project under
`/opt/containers/<name>/compose.yaml` — the file is the source of truth, usable
without HSI:

```bash
docker ps -a                  # list containers, including stopped ones
docker logs -f <name>
docker start|stop|restart <name>
docker inspect <name>         # ports, mounts, env, labels — everything HSI showed you

# Compose project (the file HSI generates/edits):
docker compose -f /opt/containers/<name>/compose.yaml ps
docker compose -f /opt/containers/<name>/compose.yaml up -d
docker compose -f /opt/containers/<name>/compose.yaml logs -f
docker compose -f /opt/containers/<name>/compose.yaml down
```

`x-hsi:` keys in the compose file are HSI metadata (pinned URL, UI hints) — safe
to ignore or delete.

Directories under `/opt/containers` whose names HSI cannot represent (spaces,
leading dot) are ignored by the app list — manage them with plain docker compose.

## Samba (SMB shares)

HSI owns its own config file, `/etc/nasui/samba/smb.conf`, and points `smbd` at it
through a systemd drop-in (`/etc/systemd/system/smbd.service.d/nasui.conf`). The
Samba package's own `/etc/samba/smb.conf` is never touched, so `apt upgrade` never
conflicts with it.

```bash
testparm -s /etc/nasui/samba/smb.conf   # validate the config HSI generated
smbstatus                               # who's connected, to which share
systemctl restart smbd                  # apply a config change by hand
```

Samba's user database is managed the normal way (`smbpasswd`) — HSI keeps it in
sync when you change a password through the UI, but doesn't replace it with its own
store.

```bash
pdbedit -L                    # list Samba accounts
smbpasswd -x <username>       # remove one — e.g. after disabling "Samba identity"
                               # for a user in HSI, which stops syncing it but never
                               # deletes it for you
```

## Users (Linux/Samba identity)

Every HSI user maps 1:1 to a Linux account by username (`/sbin/nologin` shell — no
shell/SSH access, it only exists to own files and back Samba). A Samba account is
provisioned for it too, unless "Samba identity" is turned off for that user
(Settings → Users → a user → Identity). HSI never invents its own separate
user/permission store for either — `id <username>`, `getent passwd <username>`, and
`pdbedit -L` are always the ground truth, and HSI's Identity panel is a read-only
view over exactly those facts, not a cache that can drift from them.

```bash
id <username>                 # Linux uid/gid/groups
getent passwd <username>      # full Linux account record
```

## RAID (mdadm)

Arrays HSI creates are plain `mdadm` arrays. Their assembly config is written to
the standard location so they still auto-assemble on boot without HSI running.

```bash
cat /proc/mdstat                  # live array state
mdadm --detail /dev/md0           # full detail on one array
cat /etc/mdadm/mdadm.conf         # HSI adds one marked ARRAY line per array it creates
```

### Replacing a failed disk

Storage > RAID shows each member as Active, Failed or Spare, with the disk model
and serial number to find it physically. The same steps by hand:

```bash
cat /proc/mdstat                              # (F) marks a failed member
mdadm --detail /dev/md0                       # state of every member
mdadm --manage /dev/md0 --fail /dev/sdb       # if the kernel has not marked it yet
mdadm --manage /dev/md0 --remove /dev/sdb     # or --remove detached if the disk is gone
mdadm --manage /dev/md0 --add /dev/sdf        # at least as large as the smallest member
watch cat /proc/mdstat                        # recovery = NN.N% while it rebuilds
```

Supported levels: RAID 0 (no redundancy, nothing to replace), RAID 1, RAID 5 and
RAID 10. Until the rebuild finishes the array has no redundancy left (RAID 5,
RAID 10 pair, two-disk RAID 1): avoid heavy writes and keep a backup.

## Mounts

Mounts HSI persists go through `/etc/fstab`, the same file `mount -a` and every
distro tool already reads.

```bash
findmnt                    # current mounts
cat /etc/fstab              # persisted entries
mount -a                    # (re)apply fstab by hand
```

## systemd services

HSI itself is three ordinary systemd units — see [Services](../README.md#services)
in the README for the full list and log commands.

```bash
systemctl status hsi hsi-root-worker hsi-nats
journalctl -u hsi -f
```

## What this doesn't cover yet

Users/groups and LVM are also implemented as standard Linux mechanisms (Linux
accounts, `lvm2`) rather than HSI-private state, but don't have a documented
manual-recovery workflow yet. Scheduled rsync backups are the one exception worth
flagging explicitly: the schedule itself (`apps/backend/src/services/
backup-scheduler.ts`) is HSI-internal, not `cron` — a plan won't run on its own if
`hsi` is stopped. The `rsync` command a plan builds, though, is a normal one you can
always run by hand from the plan's source/destination and options.

If you need a manual-recovery workflow that isn't written here yet, the relevant
root-worker source (`apps/root-worker/`) is the authoritative reference for exactly
what commands HSI runs.
