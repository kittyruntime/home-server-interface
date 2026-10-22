---
title: Install
description: Requirements, the install command, safe updates and rollback, version pinning and the first login.
---

## Requirements

- Ubuntu 24.04 on x86-64 (other distributions are not officially supported)
- `curl` and root access to run the install command (`sudo`, or `curl … | bash` from a root shell)
- The installer checks the other host packages it needs (storage tools such as `mdadm`,
  `smartmontools`, `lvm2`, `parted`, plus `openssl`, `rsync`, an OpenSSH client) and installs
  missing ones with `apt-get`; see [Host packages](/home-server-interface/reference/configuration/#host-packages)
- Optional: Docker for containers and the App Store; Samba for SMB shares
- Port 9001 (HSI, served over HTTPS) reachable from clients; ports 443 and 80 only if you turn on the standard ports

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/install.sh | sudo bash
```

The script:

1. Creates a system user
2. Installs Node.js 22 via nvm (in the app user's home)
3. Downloads and installs the [NATS](https://nats.io) message broker
4. Installs the privileged worker (`hsi-worker`)
5. Applies the database schema
6. Creates a one-time setup link (on a new installation)
7. Registers three systemd services (`hsi-nats`, `hsi-worker`, `hsi-server`) grouped under `hsi.target`, and starts them
8. Creates the local certificate authority and the server certificate (new installations), so HSI is served over HTTPS

Other options (install directory, port, skipping the seed account) are listed in
[Install / update options](/home-server-interface/reference/configuration/#install--update-options).

## First setup

A new installation has no account. At the end, the installer prints a one-time
link:

```
Finish the setup:  https://192.168.1.20:9001/setup#token=…
```

The installer also prints the SHA-256 fingerprint of the certificate authority. Your
browser warns about the certificate until you trust the authority: compare the
fingerprint it shows with the printed one, then follow
[Secure access](/home-server-interface/guide/secure-access/). nginx is no longer
installed or configured. Updating an existing installation never changes how it is
reached.

Open it to create the administrator. The setup assistant then lets you name the
server and set its time zone, and points to the next steps: a first volume,
shares, alerts. A reload or a reboot resumes where you stopped. To rebuild a
server instead, choose **Restore a backup** and restore its
[configuration backup](/home-server-interface/guide/backup-restore/).

The link works once: it is deleted when the administrator is created. The token
travels after the `#`, which browsers never send to the server, so it does not
end up in any request log. If you lost the link before that, run this on the
server for a new one (it replaces the previous link):

```bash
sudo hsi-worker setup-token
```

Installations that already have an administrator never see the assistant.

## Update

Re-run the same command. The script detects an existing installation, preserves
the database and all secrets, and restarts the services. Installs from before
`hsi.target` are migrated automatically (`hsi` becomes `hsi-server`,
`hsi-root-worker` becomes `hsi-worker`).

Administrators can also update from the dashboard, which checks for new releases
and runs pre-flight checks before installing one. The result of the last update
shows in Settings.

### Pin a version

```bash
curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/install.sh | sudo VERSION=v1.54.0 bash
```

## Updates

How an update is made safe:

- **Signed.** Each release carries `SHA256SUMS` (the checksums of the archive and
  of `install.sh`) and `SHA256SUMS.sig`, an ed25519 signature of that file. The
  installer and the worker check the signature with a public key they already
  hold, then the checksums, before running anything from the download. Updates
  never fetch code from the `main` branch. The checks need OpenSSL 3 or newer.
- **Side by side.** A version is unpacked into `/opt/hsi/releases/<version>/`
  and `/opt/hsi/current` points to the active one. The two previous versions are
  kept. Your data never moves: `/opt/hsi/.env`, `/opt/hsi/database/data`,
  `/opt/hsi/data`, `/etc/hsi` and `/var/lib/hsi`.
- **Snapshot.** Before switching, the database and the configuration files are
  copied to `/var/lib/hsi/update/<from>-<to>/` (the two latest are kept).
- **Health gate.** After the switch the update waits up to two minutes for the
  server to answer `/health` with the new version and the database reachable,
  and for the worker to answer. If it does not, or if the update fails or is
  interrupted, the previous version and the snapshot are restored
  automatically.

### Roll back by hand

```bash
sudo hsi-worker update status      # last update result and the rollback point
sudo hsi-worker update rollback
```

`rollback` shows the previous version and the date of its snapshot, and asks
for confirmation. It restores the previous code, the database and the
configuration files as they were at the snapshot. Everything changed since is
lost: users, shares, settings, and anything stored in the database. Files in
your volumes and your containers' data are not touched. It is refused when no
snapshot exists.

A first update from a version published before safe updates, interrupted before
the switch, boots the old version; only the next installer run rolls back.

### Verify a release by hand

Download the files of a release and check them yourself (OpenSSL 3 needed):

```bash
V=v1.67.0
BASE=https://github.com/kittyruntime/home-server-interface/releases/download/$V
curl -fsSLO $BASE/hsi-$V-linux-amd64.tar.gz
curl -fsSLO $BASE/install.sh
curl -fsSLO $BASE/SHA256SUMS
curl -fsSLO $BASE/SHA256SUMS.sig
curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/release-signing.pub -o release-signing.pub

base64 -d SHA256SUMS.sig > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey release-signing.pub -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig.bin     # Signature Verified Successfully
sha256sum -c SHA256SUMS                          # both files: OK
```

### Releases published before signing

Releases from before signing have no `SHA256SUMS`. To update from one of them,
pass `--allow-unsigned` (or `HSI_ALLOW_UNSIGNED=1`) once, only for that step:

```bash
curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/install.sh | sudo bash -s -- --allow-unsigned
```

It installs without any signature check, and is also the way through on a host
without OpenSSL 3.

### What you trust on the first install

The very first install has nothing to verify against: you trust the HTTPS
connection to GitHub (the installer script and the release downloads) and the
repository. The public key is embedded in that script, so from then on every
update is checked against it. Source installs (`--from-source`) keep the
previous layout, with no signing, no versions directory and no health gate.

## Services

HSI runs as three systemd services grouped under `hsi.target`:

| Unit | Role |
|---|---|
| `hsi.target` | The whole stack: start, stop or restart everything at once. Enabled at boot. |
| `hsi-server` | Backend API + static file server (unprivileged user) |
| `hsi-worker` | Privileged filesystem and disk worker (runs as root) |
| `hsi-nats` | NATS JetStream message broker |

```bash
sudo systemctl restart hsi.target      # whole stack
sudo systemctl restart hsi-worker      # one component
systemctl status hsi-server hsi-worker hsi-nats
tail -f /var/log/hsi/app.log /var/log/hsi/root-worker.log
journalctl -u hsi-nats -f
```

An active `hsi.target` does not mean every component is healthy: check the
three services individually.

## Project status

- **Active development.** New features ship regularly, and some interfaces may
  still change between releases.
- **Tested on Ubuntu 24.04** (x86-64). Other distributions are not officially
  supported.
- **Not security-audited.** Keep HSI updated, avoid exposing it directly to the
  internet, and consider network isolation.
