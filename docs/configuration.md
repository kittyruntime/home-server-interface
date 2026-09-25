# Configuration

## Environment variables (backend)

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | insecure dev default | Signing key for auth tokens. **Must** be set in production; the install script generates one. |
| `NATS_URL` | — | NATS server URL for talking to the root-worker. |
| `NATS_USER` / `NATS_PASS` | — | NATS credentials. |
| `BACKEND_PORT` | `9001` | TCP port the backend listens on. The installer passes it to both systemd and nginx. |
| `INSTALL_DIR` | — | Installation root; anchors runtime paths (e.g. the bundled `server.js`). |
| `DASHBOARD_PATH` | — | Path to the built dashboard the backend serves. In dev, point it at `apps/dashboard/dist`. |
| `WALLPAPER_DIR` | under `INSTALL_DIR` | Where uploaded desktop wallpapers are stored. |
| `NODE_ENV` | — | Standard Node environment flag. |
| `HSI_TELEMETRY_ENABLED` | `true` | Set to `false`, `0`, `off` or `no` to disable anonymous daily telemetry. |
| `HSI_TELEMETRY_URL` | `https://hsi-telemetry.theo-labs.dev/v1/heartbeat` | HTTPS heartbeat endpoint used by the best-effort telemetry client. |
| `HSI_VERSION` | package version | Optional explicit version reported by packaged deployments. |

> If `JWT_SECRET` is unset the backend logs a warning and uses an insecure
> default — never do this in production.

Telemetry sends only the anonymous hardware and version fields documented by
the telemetry service. Failures time out after three seconds and never block
startup or normal HSI features. The random installation UUID and last-success
timestamp are stored under `INSTALL_DIR/data` and survive upgrades.

## Install / update options

The installer (`scripts/install.sh`, run via the README one-liner) accepts these
environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `VERSION` | latest release | Install/pin a specific tag, e.g. `VERSION=v1.28.1`. |
| `INSTALL_DIR` | `/opt/hsi` | Installation directory. |
| `APP_USER` | `hsi` | System user the backend runs as. |
| `BACKEND_PORT` | `9001` | API port. |
| `NATS_SERVER_VERSION` | `v2.10.24` | NATS binary version to download. |
| `SKIP_NGINX` | `0` | Skip nginx configuration. |
| `SKIP_SEED` | `0` | Skip seeding the initial `admin / admin` account. |
| `HSI_LOG_LEVEL` | `info` | Root worker log level (`debug`, `info`, `warn`, `error`), kept in `/etc/hsi/worker.env` across updates. |
| `SKIP_DEPS_INSTALL` | `0` | Only check host packages; fail instead of installing missing ones with `apt-get`. |

Re-running the installer detects an existing installation, **preserves the
database and all secrets**, and restarts the services.

## Host packages

The installer checks these on every install and update. Missing required packages are
installed with `apt-get` (set `SKIP_DEPS_INSTALL=1` to only check them).

| Package | Needed for |
|---|---|
| `curl`, `openssl` | Downloading releases, generating secrets |
| `rsync`, `openssh-client` | Backup jobs |
| `util-linux` (`runuser`, `lsblk`, `blkid`) | Running steps as the app user, disk inventory |
| `mdadm` | RAID arrays |
| `smartmontools` | S.M.A.R.T. health |
| `lvm2` | LVM volumes |
| `parted`, `e2fsprogs`, `udev` | Partitioning and formatting |

Optional packages enable a feature and are only reported when missing:

| Package | Feature |
|---|---|
| `docker.io` (or Docker CE) | Apps and the App Store |
| `samba` | SMB sharing |
| `nginx` | Reverse proxy on port 80 |

`curl` and root access are needed before the installer can run: use
`curl … | sudo bash`, or `curl … | bash` from a root shell when `sudo` is not installed.

## systemd services

| Unit | Role |
|---|---|
| `hsi-nats` | NATS JetStream message broker |
| `hsi-root-worker` | Privileged filesystem/disk worker (runs as root) |
| `hsi` | Backend API + static dashboard server |

```bash
systemctl status hsi hsi-root-worker hsi-nats
```

## Logs

The backend and the root worker write JSON lines to files, rotated by
`/etc/logrotate.d/hsi`; NATS logs to the journal.

```bash
tail -f /var/log/hsi/app.log           # backend (HTTP requests, job outcomes)
tail -f /var/log/hsi/root-worker.log   # root worker (jobs, failed requests, commands)
journalctl -u hsi-nats -f
```

Both files use one JSON format, one line per event:

| Field | Meaning |
|---|---|
| `time` | ISO 8601 timestamp |
| `level` | `debug`, `info`, `warn`, `error` or `fatal` |
| `component` | `backend` or `worker` |
| `msg` | What happened |
| `err` | Error details (`message`, `stack`) when there is one |

Other fields depend on the event (`jobId`, `subject`, `reqId`, `username`…).
To read them comfortably:

```bash
tail -f /var/log/hsi/root-worker.log | jq -r '"\(.time) \(.level) \(.msg) \(.error // .err.message // "")"'
```

Output that bypasses the loggers (a Node.js warning, or a Go runtime crash
dump) can still appear as plain text.

Every async operation has a `jobId` that appears in both files. The worker logs
each job it receives and its outcome, and every synchronous request that fails.
Set `HSI_LOG_LEVEL=debug` in `/etc/hsi/worker.env` and restart
`hsi-root-worker` to also log successful requests.

## Ports

- **9001** — backend API + dashboard (configurable via `BACKEND_PORT`)
- **80** — nginx reverse proxy, if present (optional)
- NATS listens locally for the backend ↔ root-worker channel

## First login

The installer seeds an `admin / admin` account (unless `SKIP_SEED=1`).
**Change the admin password immediately after first login.**
