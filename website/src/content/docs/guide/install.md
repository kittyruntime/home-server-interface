---
title: Install
description: Requirements, the install command, updates, version pinning and the first login.
---

## Requirements

- Ubuntu 24.04 on x86-64 (other distributions are not officially supported)
- `curl` and root access to run the install command (`sudo`, or `curl … | bash` from a root shell)
- The installer checks the other host packages it needs (storage tools such as `mdadm`,
  `smartmontools`, `lvm2`, `parted`, plus `openssl`, `rsync`, an OpenSSH client) and installs
  missing ones with `apt-get`; see [Host packages](/home-server-interface/reference/configuration/#host-packages)
- Optional: Docker for containers and the App Store; Samba for SMB shares
- Ports 80 (nginx, optional) and 9001 (backend) reachable from clients

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
8. Configures nginx if present

Other options (install directory, port, skipping the seed account) are listed in
[Install / update options](/home-server-interface/reference/configuration/#install--update-options).

## First setup

A new installation has no account. At the end, the installer prints a one-time
link:

```
Finish the setup:  http://192.168.1.20:9001/setup#token=…
```

Open it to create the administrator. The setup assistant then lets you name the
server and set its time zone, and points to the next steps: a first volume,
shares, alerts. A reload or a reboot resumes where you stopped.

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
`hsi-root-worker` becomes `hsi-worker`); if the update fails, the previous
services are restored.

Administrators can also update from the dashboard, which checks for new releases
and runs pre-flight checks before installing one.

### Pin a version

```bash
curl -fsSL https://raw.githubusercontent.com/kittyruntime/home-server-interface/main/scripts/install.sh | sudo VERSION=v1.54.0 bash
```

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
