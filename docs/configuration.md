# Configuration

## Environment variables (backend)

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | insecure dev default | Signing key for auth tokens. **Must** be set in production; the install script generates one. |
| `NATS_URL` | — | NATS server URL for talking to the root-worker. |
| `NATS_USER` / `NATS_PASS` | — | NATS credentials. |
| `INSTALL_DIR` | — | Installation root; anchors runtime paths (e.g. the bundled `server.js`). |
| `DASHBOARD_PATH` | — | Path to the built dashboard the backend serves. In dev, point it at `apps/dashboard/dist`. |
| `WALLPAPER_DIR` | under `INSTALL_DIR` | Where uploaded desktop wallpapers are stored. |
| `NODE_ENV` | — | Standard Node environment flag. |

> If `JWT_SECRET` is unset the backend logs a warning and uses an insecure
> default — never do this in production.

## Install / update options

The installer (`scripts/install.sh`, run via the README one-liner) accepts these
environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `VERSION` | latest release | Install/pin a specific tag, e.g. `VERSION=v1.28.1`. |
| `INSTALL_DIR` | `/opt/app` | Installation directory. |
| `APP_USER` | `app` | System user the backend runs as. |
| `BACKEND_PORT` | `9001` | API port. |
| `NATS_SERVER_VERSION` | `v2.10.24` | NATS binary version to download. |
| `SKIP_NGINX` | `0` | Skip nginx configuration. |
| `SKIP_SEED` | `0` | Skip seeding the initial `admin / admin` account. |

Re-running the installer detects an existing installation, **preserves the
database and all secrets**, and restarts only the application services.

## systemd services

| Unit | Role |
|---|---|
| `app-nats` | NATS JetStream message broker |
| `app-root-worker` | Privileged filesystem/disk worker (runs as root) |
| `app` | Backend API + static dashboard server |

```bash
systemctl status app app-root-worker app-nats
journalctl -u app -f            # follow backend logs
journalctl -u app-root-worker -f
```

## Ports

- **9001** — backend API + dashboard (configurable via `BACKEND_PORT`)
- **80** — nginx reverse proxy, if present (optional)
- NATS listens locally for the backend ↔ root-worker channel

## First login

The installer seeds an `admin / admin` account (unless `SKIP_SEED=1`).
**Change the admin password immediately after first login.**
