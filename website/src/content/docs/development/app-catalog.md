---
title: Add an app to the App Store
description: The rules of the catalog, the manifest format, and the checks an app must pass.
---

The App Store is a free, curated catalog of open-source self-hosted apps.
Installing an app writes a `compose.yaml` in `/opt/containers/<name>/` that
works without HSI.

## Where the catalog lives

Apps are added and updated in the public repository
[kittyruntime/home-server-interface-apps](https://github.com/kittyruntime/home-server-interface-apps):
every change there publishes a signed `catalog.json`, which every HSI fetches
within 12 hours (or at once with **Check for new apps** in the App Store). Its
[CONTRIBUTING.md](https://github.com/kittyruntime/home-server-interface-apps/blob/main/CONTRIBUTING.md)
is the guide for adding an app.

HSI also ships a copy in `packages/app-catalog`, used when it is offline or has
never reached the repository, and replaced by the online catalog only when that
one is newer and its signature checks against the key HSI ships. An online
catalog never goes back to an older version. An app that needs a newer HSI
(`minHsiVersion`) or that this HSI cannot read is left out on its own.

The manifest format belongs to HSI (`packages/app-catalog/src/manifest.ts`).
After changing it, export it again with `pnpm --filter @app/app-catalog schema`
and copy `schema/` to the catalog repository; `pnpm test` fails until the export
is up to date. The rest of this page describes the format and the bundled copy.

## Rules

These are permanent; a pull request that breaks one is not merged.

- The app is open source and self-hosted, and its image is published by its
  own project (or a well-known packager such as linuxserver.io).
- Nothing is sold: no paid apps, tiers, subscriptions, sponsored placement or
  affiliate links, and no account needed to browse or install.
- HSI never tracks what is browsed or installed, and never hosts or
  redistributes images: a manifest points to the upstream image.

## Files

An app is two files, named after its `id`:

- `packages/app-catalog/apps/<id>.json`: the manifest;
- `packages/app-catalog/icons/<id>.svg`: its logo, square, with a `viewBox`
  and no script.

Then register it:

- import the manifest in `packages/app-catalog/src/index.ts` and add it to
  `RAW`;
- add the logo to `ICONS` in `packages/app-catalog/src/icons.ts` (the inline
  copy the dashboard renders; prefix any internal `id` with the app's id).

## Manifest

```json
{
  "id": "it-tools",
  "name": "IT Tools",
  "category": "Developer",
  "tagline": "Collection of handy online tools for developers.",
  "description": "What it does, in two or three sentences.",
  "website": "https://it-tools.tech",
  "changelog": "https://github.com/CorentinTh/it-tools/releases",
  "image": "corentinth/it-tools:2024.10.22-7ca5933",
  "webUiPort": 80,
  "ports": [{ "container": 80, "protocol": "tcp", "label": "Web UI", "hostDefault": 8085 }],
  "env": [{ "key": "ADMIN_TOKEN", "prompt": "Admin token", "secret": true, "required": true }],
  "volumes": [{ "target": "/data", "label": "Data", "suggest": "place" }]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and `-`; the file names use it |
| `category` | `Media`, `Productivity`, `Network`, `Downloads`, `Developer` or `Utilities` |
| `tagline` | One line, 120 characters at most |
| `image` | Pinned to a version tag or a `@sha256:` digest, never `latest` |
| `changelog` | HTTPS link to the release notes, shown when an update is offered |
| `webUiPort` | The container port of the web interface, for the Open button |
| `ports[].hostDefault` | The host port suggested at install; HSI offers a free one if it is taken |
| `env[].secret` | Masked everywhere; HSI offers to generate a value |
| `env[].required` | The install asks for it |
| `volumes[].suggest` | `place` (a folder of a Place, the default), `named` (a Docker volume) or `bind` |
| `volumes[].readOnlyDefault` | Mounted read-only unless changed |
| `restartPolicy` | `unless-stopped` by default |

### Services beside the app

An app that needs a database or a cache lists it in `services`. A service is
reached by its name on the app's network, never publishes a port, and keeps
its data in a named volume. An env value can quote one of the app's settings
as `{{KEY}}`, so both sides share a generated password:

```json
"services": [{
  "name": "db",
  "label": "MariaDB (database)",
  "image": "mariadb:11.4",
  "env": { "MARIADB_PASSWORD": "{{MYSQL_PASSWORD}}" },
  "volumes": [{ "name": "db", "target": "/var/lib/mysql" }]
}]
```

## Checks

- `pnpm test` loads every manifest with its schema, and checks that each
  `apps/<id>.json` is registered under its file name with an icon, and that
  no icon is left without an app.
- `scripts/check-catalog-images.sh` reads every pinned image (apps and
  services) from its registry and checks it exists for `linux/amd64`. The
  `App catalog` workflow runs it on pull requests that touch the catalog and
  every week, so an image removed upstream is noticed.
- Install the app from the store on a test server, open it, then remove it.
