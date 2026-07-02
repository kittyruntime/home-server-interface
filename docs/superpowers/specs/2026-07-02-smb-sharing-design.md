# Design: SMB Network Sharing (Samba)

**Date:** 2026-07-02
**Status:** Approved

## Problem

nasui manages Places (named, path-scoped folders with per-role/per-user permissions) and lets users browse them through the web file browser, but there is no way to access them over the local network from a file manager (Windows Explorer, macOS Finder, Linux). A NAS without network shares is incomplete.

The feature exposes Places as SMB shares, reusing the existing Place permission model and the existing `linuxUsername` system-account provisioning — no parallel permission system.

**Scope decision:** SMB only. NFS was considered and explicitly dropped during design ("okretire l'idée du NFS") — SMB covers all client OSes, and dropping NFS removes the `protocol` and `allowedNetwork` concepts entirely.

## Hard constraints

1. **No dpkg-divert, no conffile conflicts** (user requirement: "attention dpkg/apt, je veux pas avoir a faire de divert"). The app must never modify `/etc/samba/smb.conf` (owned by the `samba` package). Instead, a systemd drop-in `/etc/systemd/system/smbd.service.d/nasui.conf` overrides `ExecStart=` to point `smbd` at a fully app-owned config file (`/etc/nasui/samba/smb.conf`). Drop-ins are the OS-sanctioned override mechanism: `apt upgrade` never touches `/etc/systemd/system/`, and removing the drop-in restores stock behavior.
2. **No automatic package installation.** The app detects whether Samba is installed and, if missing, shows the exact command to run (`apt install samba`) — it never runs `apt` itself.
3. **Web passwords are stored as irreversible hashes**, so they cannot be copied into Samba/Linux after the fact. The only sync point is the moment the user sets/changes/enters their password in plaintext. User accepted this tradeoff ("Oui, c'est acceptable").
4. **One password everywhere, NAS-style** (user requirement: "l'idée c'est de sync le mdp user/smb/linux comme sur un NAS"). The same password is propagated to the web account, the Samba account, and the Linux system account. Linux accounts are created with `-s /sbin/nologin` (see `handleLinuxUserCreate`), so setting a Linux password grants no shell/SSH access — it only keeps the accounts consistent.

## Section 1 — Data model

One new Prisma model (new file `packages/database/prisma/schema/share.prisma`, matching the per-model file layout):

```prisma
model Share {
  id          String   @id @default(uuid())
  placeId     String   @unique
  place       Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)
  enabled     Boolean  @default(true)
  readOnly    Boolean  @default(false)
  smbName     String?  // name shown to SMB clients (default: place.name)
  guestOk     Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- `placeId @unique`: at most one share per Place.
- `onDelete: Cascade`: deleting a Place removes its share (and the next sync removes it from Samba).
- No `protocol` field (SMB only), no `allowedNetwork` field (was NFS-specific; SMB access control is user-based).

## Section 2 — Backend & root-worker

### root-worker (Go), new NATS handlers under `root.sharing.*`

- **`root.sharing.sync`** — receives the complete desired state (list of enabled shares with their resolved user lists), regenerates `/etc/nasui/samba/smb.conf`, then `systemctl reload smbd`. Idempotent: replayable with no side effects. Samba always reflects the current DB/permission state; there is no incremental diffing.
- **`root.sharing.setPassword`** — receives `{linuxUsername, password}` (plaintext, never stored) and syncs it to both accounts: `chpasswd` for the Linux system password (shell stays `/sbin/nologin`, so no login access is granted) and `smbpasswd -s -a <user>` for Samba. Both fed via stdin — never written to disk in plaintext.
- **`root.sharing.status`** — runs `smbstatus --json`, returns active SMB connections (user, client IP, share, connected-since).
- **`root.sharing.checkPrereqs`** — detects whether `smbd` (binary + systemd unit) is present. Returns installed/missing. **No apt install** — detection only.

### One-shot setup (first activation)

When the first share is created, root-worker writes the systemd drop-in `/etc/systemd/system/smbd.service.d/nasui.conf` (overriding `ExecStart=` to use `/etc/nasui/samba/smb.conf`) and runs `systemctl daemon-reload`. Done once, idempotent if the drop-in already exists.

### Backend (tRPC), new router `sharing.ts`

- **`list` / `create` / `update` / `remove`** — CRUD on `Share`, admin-only (like Storage). After every mutation, resolve the authorized users from the Place's permissions, then call `root.sharing.sync`.
- **`status`** — proxy to `root.sharing.status` for the connections view.
- **`checkPrereqs`** — proxy to `root.sharing.checkPrereqs` for the UI's missing-prerequisites state.
- **Password hook** in the existing password-change path (`user.service.ts`): if the user has a `linuxUsername`, call `root.sharing.setPassword` with the plaintext password just before it is hashed — syncing web, Linux, and Samba passwords in one step (NAS-style single password). Best-effort: a sync failure (e.g. Samba not installed) must not fail the password update. Same hook applies at account creation and login-time capture points where the plaintext is available (login-time capture backfills existing users who never changed their password after the feature ships).

## Section 3 — Permission mapping

When a share is created/modified for a Place, the backend resolves the authorized user list from the Place's existing permissions (`UserPlacePermission` + `RolePlacePermission`, aggregated the same way as everywhere else in the app):

- Users with `canRead` → `valid users =` in the generated `smb.conf`
- Users with `canWrite` → additionally in `write list =`
- Users without a `linuxUsername` are excluded (cannot have a Samba account) — surfaced as a warning in the UI when this shrinks the effective list
- If `guestOk` is enabled, the share is also accessible unauthenticated, in addition to the listed users

No duplication of the permission model: Samba always reflects the Place's current state, recomputed on every `sync`. Changing a Place's permissions should also trigger a `sync` (same resolve-then-sync path as share mutations).

## Section 4 — Frontend UI

New **"Sharing" desktop app** (admin-only, like Storage/Monitor), same two-column sidebar/content layout, two sections:

### Shares

List of Places shared over SMB. Each entry shows: Place name, displayed SMB name, status (enabled/disabled), read-only flag, guest access flag, count of users with access. Actions:

- Create a share (pick an existing Place not yet shared)
- Edit (`smbName`, `readOnly`, `guestOk`)
- Enable/disable
- Delete

A visible warning appears when some of the Place's permitted users lack a `linuxUsername` (and are therefore excluded from the effective share access).

### Connections

Live view of active SMB connections (`smbstatus`): user, client IP, share in use, connected since. Refreshed by polling (same pattern as System → Live).

### Missing-prerequisites state

If `smbd` is not installed, the Shares section shows a clear message with the exact command to run (`apt install samba`) instead of the creation form — never a cryptic error.

### Design system

Follows the refreshed tokens: `.panel-card` for cards, `.badge` for statuses, standard `.btn` variants, Inter everywhere except technical values (client IPs in Space Mono in the Connections view).

## Out of scope

- NFS (explicitly dropped)
- Per-share network/IP restrictions (was NFS-specific)
- Automatic Samba installation via apt
- Time Machine / AFP / WebDAV
- Non-admin share management
