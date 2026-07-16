# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Web file manager couldn't write to places without an SMB share**: writing through the built-in file browser acts as your Linux user (same as SMB), so it hit the same wall — the shared-group/writable-directory setup only ran for SMB shares. Now **every place you're granted write on** is placed in the `hsi-share` group (setgid, group-writable), share or not, so the web file manager can write there too. Applies the next time a permission changes (or on the next sync).

### Security
- **`root` can no longer be an SMB share account**: HSI never adds `root` (e.g. an admin account mapped to the Linux `root` user) to a share's Samba valid-users / write-list, nor to the `hsi-share` group. Writing to shares as root is unsafe and Samba refuses a root login anyway (it falls back to guest → read-only), so mapping an account to root produced a share only "root" could write — which nothing could actually use. Give SMB users a normal (non-root) Linux account.

## [1.33.1] - 2026-07-15

### Fixed
- **Can't write to an SMB share (even as admin)**: writes failed for two reasons — admins were never added to a share's Samba *write list*, and shared directories were created root-owned and not writable by the users granted write (which also affected the web file browser, since both write as your Linux user). Now admins always get read+write on every share, and each writable share directory is placed in a shared `hsi-share` group — setgid and group-writable, with the write-permitted users as members — so both SMB and the web file manager can write. New files are group-writable too. Takes effect on the next share sync; SMB clients may need to reconnect once for the new group membership to apply.

## [1.33.0] - 2026-07-15

### Added
- **Reorderable sidebar**: drag any app icon in the sidebar to arrange the nav in whatever order you like — the order is saved to your account and mirrored in the mobile bottom bar. A plain click still opens the app, and keyboard users can move a focused icon with Alt+↑ / Alt+↓. "Reset sidebar order" (in the profile menu) restores the default.
- **Preferences follow your account**: your theme, accent colour and sidebar order now sync across the browsers and devices you sign in on (loaded on login, saved as you change them; localStorage stays the instant local cache). Device-specific settings like desktop mode remain per-browser.

### Fixed
- **App Store live status**: catalog cards now show each app's real container state (Running / Stopped) read from Docker, instead of a persisted status that was never refreshed after install — so a freshly-installed app correctly moves from "Installing…" to "Running" on its own.

### Security
- **Audit log**: user-submitted secret env **values** (e.g. an `ADMIN_TOKEN` you type at install) are now redacted in the audit log. Previously the redaction matched only the field *name*, so the secret in `value` was written in cleartext; the setting's name is now kept for auditability while its value is masked. (Server-generated secrets were never logged.)

## [1.32.0] - 2026-07-15

### Added
- **Host-port conflict warning**: when you pick a host port for an app (App Store install wizard or the container form), HSI now warns if that port is already taken — by another HSI app, any Docker container (incl. Compose stacks), or a non-Docker process on the host. It's a non-blocking heads-up (the port still binds), so you can fix it before Docker fails to start the second app.
- **Per-port access binding**: each published port can record where it's actually reached — an optional domain, an HTTPS toggle, and an optional external port — set in the app's settings (Ports). HSI doesn't terminate TLS or run a proxy; it just stores the binding so the **Open** button goes to the real URL (e.g. `https://jellyfin.example.com`) instead of `http://<host>:<port>`. Universal because it's plain per-container metadata, whatever handles TLS externally (your reverse proxy, tunnel, or router).

## [1.31.1] - 2026-07-14

### Changed
- **App Store polish**: the catalog now shows each app's **real logo** instead of a generic glyph, and the App Store launcher icon is a storefront (clearer, and distinct from the Apps grid). Each catalog card shows the app's live state — Not installed, Installing…, Running, Stopped or Error — with a contextual **Install** or **Open** action (Open launches the app's web UI on its mapped port). The screen refreshes on its own so a fresh install visibly moves from "Installing…" to "Running", and it now shows a loading skeleton and a "no results" state.

## [1.31.0] - 2026-07-13

### Added
- **App Store**: a new admin-only "App Store" app that installs curated self-hosted apps in one guided flow. Browse a catalog of 10 apps (Jellyfin, Vaultwarden, Navidrome, AdGuard Home, Syncthing, qBittorrent, Uptime Kuma, File Browser, Homarr, IT-Tools) with search and category filters, then install through a wizard that lets you set the app name, remap host ports, fill in settings, and — for each volume — pick an existing Place, create a new Place, use a host path (bind mount), or a named Docker volume. It reuses the existing container-create pipeline: images are pinned (never `:latest`), secrets like admin tokens are generated for you, and installed apps are tagged so the store shows what's already installed. Creating a new Place during install stays admin-only.
- **Read-only volume mounts**: container volumes can now be mounted read-only (`:ro`), used by the App Store for library volumes (e.g. a media folder mounted read-only).

## [1.30.0] - 2026-07-12

### Added
- **Download a shared folder as a zip**: public folder share links now have a "Download all as .zip" button. The worker builds the archive into a private temp dir with a hard disk-space guard — it re-checks free space as it writes and aborts before the (limited) temp filesystem can fill, plus a size cap — streams it to the visitor, then removes it (no temp file ever lands inside the shared tree). Concurrent builds are capped and any orphaned archive is swept periodically.

### Changed
- Relicense the project under the Mozilla Public License 2.0 (`MPL-2.0`), replacing the previous source-available, non-commercial license.
- **User accounts require a Linux-valid username**: creating a user now requires the username to be a valid Linux account name (lowercase letters/digits/`-`/`_`, starting with a letter or `_`), enforced in the create form and server-side. This guarantees every account can back a Linux and Samba (SMB) account — previously an invalid name (uppercase, dots…) silently produced an account with no file-server or SMB access.

## [1.29.2] - 2026-07-11

### Security
- **CodeQL hardening**: bounded the root worker's uid/gid parsing with `strconv.ParseUint(…, 32)` instead of `Atoi` + an unchecked `uint32` cast (clears `go/incorrect-integer-conversion`), and restricted the CI workflow's `GITHUB_TOKEN` to `contents: read` (clears `actions/missing-workflow-permissions`).

## [1.29.1] - 2026-07-11

### Fixed
- **Share action missing from the right-click menu**: the file browser's "Share" action was only on the selection toolbar, not the right-click context menu. It's now in both (for files and folders), acting on the right-clicked item via the same dialog.
- **Metrics history broke on machines with ≥2 GB RAM**: the `MetricSnapshot` RAM and network columns were 32-bit `Int`, so a RAM total in bytes (≥2 GB) overflowed and every metrics sample failed to write (`P2023`), leaving the Monitor → History charts empty. Those columns are now `BigInt`. The updater also now runs `prisma db push --accept-data-loss` (right after its existing automatic DB backup) so column-type changes actually apply on update instead of silently failing.

## [1.29.0] - 2026-07-11

### Added
- **Public file sharing**: share any file or folder over a public link (`/s/<token>`) with no account required for the recipient. Each link supports an optional password, an expiry, and a maximum download count, and can be revoked at any time. Visitors get a page that downloads the file or lets them browse a read-only folder listing; the link inherits the creator's read permission (re-checked on every access) and is contained to the shared path — symlink- and traversal-safe — on the privileged worker. Creating links is gated by a new per-place **Share** permission, grantable to a user or a role like Read/Write/Delete. Manage your links from Settings → Shared links.

### Changed
- **Logs**: the backend and the root worker now write their output to `/var/log/hsi/app.log` and `/var/log/hsi/root-worker.log` (created on install, rotated weekly) instead of only the systemd journal, so operators have plain log files to tail and ship.

### Fixed
- **Samba password sync**: password sync now logs a clear warning when the Samba (`smbpasswd`) or Linux (`chpasswd`) step fails, instead of swallowing it silently — making a refused SMB login diagnosable from the backend log.

## [1.28.6] - 2026-07-10

### Changed
- **License**: strengthened the non-commercial license — an explicit "source-available, NON-COMMERCIAL" header, a definitions section (notably a broad definition of "commercial use"), a clear commercial-use prohibition that reserves a written commercial-license option, and added trademark, termination and full no-warranty clauses. Renamed the project from "Brume" to **HSI (Home Server Interface)** in the license and NATS config (the rest of the codebase already used the current name).

## [1.28.5] - 2026-07-10

### Changed
- **Places settings**: reworked the Places screen to explain what a place is and guide setup — a descriptive header, per-field hints on the add form, a guided empty state, and a short explanation of the read / write / delete permissions (with per-column tooltips and a note that admins always have full access). The "Add place" trigger now uses the shared button style.

### Fixed
- **Update release notes**: the "What's new" panel now renders release notes as formatted text (headings, lists, bold, inline code, links) instead of raw Markdown. The Updates screen also links out to the specific release and to the project on GitHub.

## [1.28.4] - 2026-07-10

### Changed
- **Button consistency**: unified every call-to-action on the shared `.btn` design-token classes (`.btn-primary`/`.btn-outline`/`.btn-ghost`/`.btn-danger`). The primary button is now solid accent (following the accent-colour picker) instead of a mix of punched-out and inline accent styles; LVM wizard CTAs are no longer a stray purple, and destructive confirmations (Format, Create RAID, Destroy…) share one danger style. 82 buttons now use the shared system (was 36); no more inline accent or hard-coded-colour CTAs.
- **Storage app icon**: replaced the single cylinder glyph with a clearer three-bay disk rack (with drive LEDs), in the desktop launcher, sidebar and mobile nav.

## [1.28.3] - 2026-07-09

### Security
- **JWT signing key**: the backend now refuses to start in production (`NODE_ENV=production`) when `JWT_SECRET` is missing or shorter than 32 characters, instead of silently falling back to a public development default that would let anyone forge session tokens. Development keeps the warn-and-fallback behaviour. (The install script already generates a 64-char secret, so existing installs are unaffected.)
- **Default-password warning**: when an account is still signed in with the seeded default password, the dashboard now shows a dismissible banner linking straight to the password-change screen. The check runs server-side (`user.securityStatus`) and never exposes the password hash.

### Changed
- **Linting**: added ESLint (flat config, Vue `flat/essential` + typescript-eslint) over all TS/Vue code and a `gofmt` + `go vet` gate for the Go root-worker, wired into a new CI `lint` job. Fixed the handful of real issues this surfaced (a `String` wrapper type, an unused-expression ternary, a useless assignment, an unused prop binding) and normalised the root-worker's Go formatting. Run locally with `pnpm lint`.

### Fixed
- **Expired sessions**: when a stored session token is rejected (expired or revoked), the dashboard now clears it and redirects to the login screen instead of leaving the user on a silently-failing page. A failed login attempt is unaffected (no redirect loop).
- **Error states**: the Audit Log and the System → History charts now show a distinct error message with a Retry button when their data fails to load, instead of falling through to their "no data" empty state (which misrepresented a failure as an absence of activity).

## [1.28.2] - 2026-07-07

### Security
- **Dependencies**: removed two stale per-app `pnpm-lock.yaml` files left over from the initial import. The repo is a pnpm workspace that only uses the root lockfile (already on patched versions), so these files carried only fossilised vulnerable versions and were the sole source of 24 phantom Dependabot alerts (11 high, 11 moderate, 2 low). Alert count is now 0.

## [1.28.1] - 2026-07-06

### Changed
- **Navigation**: reordered the app nav to a more natural flow — Overview, Files, Apps, then the admin tools (Storage, Monitor, Sharing), with Settings last, consistent across the classic sidebar, mobile bar and Launchpad. The Storage → Disks tab also gets a clearer hard-drive icon.

## [1.28.0] - 2026-07-06

### Changed
- **Storage dialogs**: the format wizard, mount/unmount, LVM/RAID wizards and partition/destroy confirmations now use the shared modal component — so they animate in and out, join the layered-Escape stack, and (in desktop mode) render inside their window instead of covering the whole screen, matching every other dialog in the app.

### Performance
- **Smaller initial load**: the Storage, Monitor, Apps, Settings and Sharing panels are now code-split into separate chunks loaded on first open. The initial JavaScript bundle drops from ~865 KB to ~274 KB.

## [1.27.2] - 2026-07-06

### Security
- Updated dependencies to clear all 25 known vulnerabilities (12 high) reported by `pnpm audit` / Dependabot — notably fastify, vite, rollup and Prisma patch/minor bumps, and `@fastify/static` 8 → 9 which fixes a path traversal and a route-guard bypass in the layer that serves the dashboard.

## [1.27.1] - 2026-07-06

### Added
- **Sharing in classic mode**: the SMB Sharing app is now reachable outside desktop mode — admin-only entry in the classic sidebar and the mobile bottom nav.

### Changed
- **Classic mode animations**: switching apps in classic (non-desktop) mode now cross-fades, matching the motion system introduced in 1.27.0.

### Fixed
- **Windowed modals**: dialogs opened by an app running in a desktop window (file properties, permissions, pin/edit forms…) now display inside that window instead of covering the whole screen. System-level dialogs (confirmations, wallpaper picker) stay fullscreen.

## [1.27.0] - 2026-07-06

### Added
- **Motion system**: the dashboard now animates on design-token durations/easing — modals and confirm dialogs pop in and out, the launchpad zooms, desktop windows animate on open/close/minimize, pinned apps slide into place when added or removed, and route changes cross-fade. Everything collapses to instant under `prefers-reduced-motion`.

### Changed
- **Design tokens**: finished migrating the remaining raw palette colors to semantic status tokens (storage sections, overview, audit log, notifications, profile, permissions, RAID drive-bay illustration), exposed them as Tailwind utilities, and moved all radii to the shared token scale. Destructive/confirm buttons keep a visible hover state; the audit-log `fs` category gets a proper violet token with a dark-mode variant.

### Fixed
- **Escape key**: with stacked overlays (a confirm dialog over the launchpad, or an open role picker inside a modal), Escape now closes only the topmost layer instead of everything at once.
- **Confirm dialogs**: a confirmation requested while the previous one was still animating out could be silently auto-cancelled; it now shows correctly. Confirm/Cancel also play the dialog's leave animation instead of snapping it away.

## [1.26.0] - 2026-07-03

### Changed
- **App icons**: redesigned the seven desktop app glyphs (Dock, Launchpad, window title bars) as a custom monochrome family — consistent rounded stroke on a 24px grid with filled-dot details (drive LEDs, share nodes, slider knobs); Settings trades the cog for three sliders and the dock's Launchpad button becomes a four-dot grid. Icons are now rendered by a shared `AppIcon` component instead of three inline SVG copies.

## [1.25.0] - 2026-07-02

### Added

- SMB network sharing: share any place over the network via Samba, managed from the new admin-only Sharing desktop app (share list with per-place permissions mapping, live connections view, guest access and read-only options). Passwords are kept in sync NAS-style across web, Linux, and Samba accounts. Requires `samba` to be installed on the host; the app detects it and shows the install command otherwise.

## [1.24.0] - 2026-07-01

### Fixed
- **Wallpaper upload**: fixed `ENOENT` failure on every wallpaper image upload in production installs. The backend's bundled `server.js` sits directly at `INSTALL_DIR`'s root, so the storage path fallback (relative to the *unbundled* dev source tree) walked two directories above `INSTALL_DIR` and tried to write to `/data` at the filesystem root — outside the systemd sandbox's writable paths. Now resolves against `INSTALL_DIR` directly.

## [1.23.2] - 2026-07-01

### Fixed
- **Updates**: fixed the update UI getting permanently stuck on "Restarting" — it only detected a thrown `fetch()` exception as "server down," so it missed nginx's 502 (backend port closed) and the backend's own 503 (NATS not yet reconnected), both successful HTTP responses. A manual page reload was required after every update; now the UI correctly detects the restart and reloads automatically.
- **Design system**: finished the refresh consistency pass — Overview summary cards now use the shared `.panel-card` (elevation/radius), remaining pill-shaped badges (audit categories, RAID/LVM tags and counters) moved to the moderate radius token, and destructive UI (delete confirmations, danger zone) now uses the fixed `--c-danger` color instead of the user's accent color.

## [1.23.1] - 2026-07-01

### Fixed
- Translated remaining French UI text and code comments to English (Storage → Mounts/Physical Disks/RAID titles, subtitles, and table headers; VolumesTable comments).

## [1.23.0] - 2026-07-01

### Changed
- **Design system refresh**: moved away from the flat/monochrome "Nothing" look toward a warmer, softer balance — Inter replaces Space Mono for buttons, badges, labels, and nav (Space Mono now scoped to technical data values only: metrics, file sizes, IPs, hashes); buttons and badges lose their pill shape for a moderate rounded radius; cards and modals gain a subtle resting/hover shadow; destructive actions now use a fixed danger color independent of the accent picker; backgrounds are slightly warmed in both light and dark mode.

## [1.22.0] - 2026-07-01

### Changed
- **Updates**: reworked update UI — version comparison card, release notes panel (populated after "Check now"), 4-step restart timeline (Scheduled → Restarting → Reconnecting → Ready), and auto-reload countdown once the server is back up.

## [1.21.0] - 2026-07-01

### Changed
- **Storage** is now a dedicated desktop app (Disks, RAID, LVM, Mounts) — accessible from the Launchpad and the non-desktop sidebar (admin only).
- **Monitor** is now a dedicated desktop app (Overview, System, Audit Log) — accessible from the Launchpad and the non-desktop sidebar (admin only).
- **Settings** is now purely configuration: Profile, Users, Places, Permissions, Roles, Updates.

## [1.20.0] - 2026-07-01

### Added
- **Permissions**: new Settings → Permissions section — per-place access control matrix (read/write/delete) for every role and user.
- **Overview**: new Settings → Overview dashboard — live summary cards for system health (CPU/RAM/uptime), storage (disks, RAID status), containers (running/stopped), LVM, and recent audit activity.
- **File search**: search bar in the file browser — searches by filename within the current place, results navigate to the containing directory.
- **Historical metrics**: Settings → System → History tab — CPU %, RAM, and network charts (Chart.js) with 1h/6h/24h/7d periods; metrics sampled every 60 seconds and retained for 30 days.

## [1.19.1] - 2026-06-30

### Fixed
- Storage nav labels were in French ("Disques", "Montages"); renamed to English ("Disks", "Mounts").

## [1.19.0] - 2026-06-30

### Added
- **Storage split**: replaced the monolithic `DisksSection.vue` (2191 lines, 3 internal tabs) with four independent nav sections under Settings → admin:
  - **Disques** (`PhysicalDisksSection`) — physical disk cards, S.M.A.R.T. health, partition management.
  - **RAID** (`RaidSection`) — RAID array creation, destruction, live status, device bay.
  - **LVM** (`LvmSection`) — PV / VG / LV lifecycle (create, remove, resize).
  - **Montages** (`MountsSection`) — centralized view of all mounted and unmounted filesystems across disks, RAID arrays, and LVM logical volumes, with mount/unmount/format actions and clickable source badges that navigate to the owning section.
- Shared `useStorageData` singleton composable: one reactive store, one fetch cycle, one `refresh()` shared across all four sections. Navigating between storage sections never triggers duplicate API calls.
- Cross-section navigation: disk used as RAID member → badge links to RAID; disk or RAID used as LVM PV → badge links to LVM; RAID member drives clickable → links to Disques.

## [1.18.2] - 2026-06-29

### Fixed
- Build: AuditLogSection imported `inferRouterOutputs` from `@trpc/server` which is not a dashboard dependency; replaced with `Awaited<ReturnType<...>>` derived from the proxy client.

## [1.18.1] - 2026-06-29

### Fixed
- Build: AuditLogSection used `useQuery` from `@trpc/vue-query` which is not in this project; replaced with vanilla proxy client calls. Removed unused `TRPCError` import in auth router.

## [1.18.0] - 2026-06-29

### Added
- **Audit Log**: every authenticated mutation is now recorded in a persistent SQLite table (`AuditLog`). Captured fields: user, action (tRPC path), primary target resource, sanitized input (sensitive fields redacted recursively), client IP, success/failure, timestamp.
- Failed login attempts are also logged (with the attempted username as target) even though they originate from a public procedure.
- New **Settings → Audit Log** section (admins only): paginated table (50 entries/page) with colour-coded action badges by category (auth, filesystem, system, admin), expandable row detail showing sanitized input JSON, and a free-text action filter.

### Fixed
- Audit meta sanitization now recurses into nested objects/arrays and applies a case-insensitive regex (`password`, `secret`, `token`, `key`, `auth`, `credential`) instead of a flat denylist.

## [1.17.1] - 2026-06-29

### Fixed
- Build: resolved `TS2532` (Object is possibly undefined) errors in SMART panel template; CI now passes vue-tsc strict checks.

## [1.17.0] - 2026-06-29

### Added
- **S.M.A.R.T. health panel** for physical disks: each disk card now has a color-coded health badge (Healthy / Warning / Failed) with live temperature. Clicking the badge expands a panel showing:
  - Overall health status, temperature, power-on hours, and power cycle count.
  - Device info: model family, serial number, firmware version, drive type (NVMe / SSD / HDD + RPM).
  - ATA attribute table with critical attributes highlighted; failed attributes shown in red.
  - NVMe health log: critical warning, available spare, percentage used, media errors, and lifetime data read/written in TiB.

## [1.16.0] - 2026-06-29

### Added
- Storage section is now split into three focused tabs: **Disks**, **RAID**, and **LVM** — each with a live count badge.
- LVM wizard: assembled RAID arrays (md devices) can now be selected as Physical Volume candidates, enabling LVM-over-RAID setups. They appear in the picker with a RAID badge.

### Fixed
- RAID wizard: already-assembled md devices and disks that are already RAID members are now excluded from the drive picker.
- LVM wizard: disks that are RAID members are now excluded from the PV picker.
- LVM format and mount operations now send the correct `/dev/vg-name/lv-name` symlink path to the worker instead of a constructed dm name that does not exist as a device file.
- `lvToBlockDev` now correctly resolves the dm device using the LVM double-hyphen naming convention, so filesystem type, mount point, and usage data appear correctly for logical volumes.
- System LVM protection: Volume Groups whose Logical Volumes are mounted at critical paths (`/`, `/boot`, `/var`, etc.) are now correctly detected as system VGs — all destructive actions (Remove VG, Remove LV) are hidden.
- FAT32 formatting now tries `mkfs.fat` first (modern name) before falling back to `mkfs.vfat`.
- Device name validation in Go and tRPC now accepts hyphens and one forward slash, allowing relative LVM paths (`ubuntu-vg/ubuntu-lv`) to pass through.

## [1.15.1] - 2026-06-29

### Fixed
- Disk management UI: redesigned storage section to be more professional and less error-prone. Destructive actions (Destroy RAID, Remove VG) are now hidden behind a ⋯ dropdown menu instead of inline red buttons. Per-partition and per-LV Delete buttons are now invisible by default and only appear on row hover. "Init GPT" (wipes partition table) is now collapsed inside an expandable "Advanced" section at the bottom of each disk card rather than shown inline next to "+ Partition". Cards now have colored left-edge accent stripes for visual type identification.
- Disk management UI: system VGs (Volume Groups that contain a mounted system partition) are now protected — the ⋯ menu and all destructive actions are hidden, and a SYSTEM badge is shown in orange.
- Go worker: `Children` field on block devices was omitted from JSON when empty (due to `omitempty`), causing the dashboard to crash with `TypeError: can't access property Symbol.iterator, G.children is undefined`. The field now always serializes as `[]` instead of being omitted.

## [1.15.0] - 2026-06-29

### Added
- LVM management: create Volume Groups from one or more physical devices, with a 3-step wizard (select PV devices → name VG/LV/optional size → confirm). Logical Volumes appear as manageable entries with Format, Mount/Unmount, and Delete actions. Per-VG controls: Add LV and Remove VG (with typed confirmation). LVM info is loaded in parallel with block devices on page open.
- Partition management: each non-system disk now has an inline partition toolbar with "Init GPT" (wipes partition table — requires typed confirmation) and "+ Partition" (creates a partition spanning all free space). Each partition row gains a "Delete" button (when unmounted and not a system partition).
- Seven new dialogs for all LVM and partition operations: LVM Create Wizard, Add LV, Remove LV, Remove VG, Init GPT, Add Partition, Delete Partition — all include warnings and typed or explicit confirmation before any destructive action.
- LVM Logical Volumes behave as first-class block devices: they show filesystem type, mount point, and usage bar if mounted, and reuse the existing Format/Mount/Unmount wizards.

## [1.14.0] - 2026-06-29

### Added
- Storage management panel: full disk/RAID/mount management UI in Settings → Disks, replacing the read-only disk view.
- Physical drive tree built from `lsblk`, showing every disk and partition with size, filesystem type, mount point, and usage bars.
- Format wizard (3 steps): danger warning → filesystem choice (ext4, xfs, btrfs, FAT32 with descriptions) → type device name to confirm. Runs `mkfs` on the worker.
- Create RAID wizard (3 steps): level selection (0/1/5/10) with redundancy explanations and capacity hints → disk picker → type `CREATE RAID` to confirm. Persists mdadm config for auto-assemble on reboot.
- Destroy RAID dialog: stops the array with `mdadm --stop` and zeroes superblocks on member drives; requires typing the array name to confirm.
- Mount dialog: configurable mount point and options, optional `/etc/fstab` UUID entry for persistence across reboots. Mount directory is created automatically.
- Unmount dialog: optional fstab entry removal.
- System disk protection: the disk containing `/` (and all its partitions) is auto-detected via `/proc/mounts` + `lsblk --pkname`, shown with an orange SYSTEM DISK badge, and all destructive actions are disabled.

### Fixed
- Security: reject fstab structural characters (`\n`, `\r`, `\t`, space, `#`) in mount point and options at both the tRPC Zod schema and Go handler layers, preventing fstab injection that could bypass the system-mount guard.
- TypeScript: removed unused `watch` import in `ContainerLogsPanel.vue` that was causing a build error.

## [1.13.0] - 2026-06-29

### Added
- Container logs: each app row now has a "Logs" button that opens a live terminal overlay streaming `docker logs --follow`. Lines include parsed timestamps, auto-scroll with a "Follow" toggle that pauses when you scroll up, a Clear button, and a line counter. The stream runs through a dedicated NATS inbox so the worker pushes lines directly and the SSE route relays them to the browser.
- File browser: the first available place (Root for admins, first assigned place for users) is now automatically selected when opening the file browser, eliminating the blank "Select a place" screen on first load.

## [1.12.3] - 2026-06-29

- File browser: the first available place is now automatically selected when opening the file browser, so the panel never shows a blank "Select a place" screen on first load.

## [1.12.2] - 2026-06-29

### Added
- File browser: uploads now appear inline as ghost rows/cards in the directory they're targeting. Each shows a live progress bar, transfer speed, and a spinner on the icon — visible immediately when the upload starts, before the file exists on disk. Works for all uploads in the current browser session (any logged-in user). The ghost disappears and is replaced by the real entry once the upload completes.

## [1.12.1] - 2026-06-29

### Added
- File browser: inline loading state on file/folder rows and cards during operations. Deleting, moving, or renaming an item dims its row/card and shows a spinner directly on it. Creating a folder shows a ghost "New Folder…" placeholder at the top of the list/grid while the operation runs.

## [1.12.0] - 2026-06-29

### Added
- Toast notifications: errors and confirmations now appear as floating overlays in the top-right corner, auto-dismissing after a few seconds. Errors persist 7 s; successes 3.5 s.
- Container actions (start, stop, restart, recreate) now show live progress in the Activity bell — a spinner while the job runs, then a green check or red cross on completion.
- Creating an HSI user now automatically provisions a Linux system user (`useradd -M -s /sbin/nologin`) with the same username. The Linux username is stored in `linuxUsername` and shown in the user table. No home directory and no SSH login are created by default.

### Fixed
- All `alert()` browser dialogs (container action errors, network/volume delete failures, unmanaged-container import errors) replaced with toast notifications — no more browser-native popups blocking the page.

## [1.11.5] - 2026-06-29

### Fixed
- Places: creating a directory (via the "Create directory" link) and validating a place path now route through the Go root-worker (`root.fs.mkdirp` / `root.fs.stat`) instead of the Node process, fixing `ENOENT` errors when the target is outside Node's accessible paths (e.g. `/mnt/`).
- Container form: `extraHosts` field was missing from the local `App` type in `AppFormModal.vue`, causing a TypeScript build error.

## [1.11.4] - 2026-06-29

### Added
- Container form: new "Extra Hosts" field in the Advanced tab — adds `--add-host hostname:ip` entries that map to `/etc/hosts` inside the container. Supports tag-based input with `hostname:ip` format validation. Compose import parses `extra_hosts` (array or map form).

## [1.11.3] - 2026-06-29

### Changed
- Container management: editing a container now opens an inline view within the app panel instead of a full-screen modal. The form replaces the list in-place with a back arrow to return.

### Fixed
- Start/Restart on a container that no longer exists in Docker now prompts "Recreate it?" instead of showing a raw error. Confirming triggers a `recreate` job using the stored configuration.

## [1.11.2] - 2026-06-29

### Added
- Places: when creating a place with a path that doesn't exist, a "Create directory and add place" link appears below the error — clicking it runs `mkdir -p` on the path and automatically retries the creation.

## [1.11.1] - 2026-06-29

### Fixed
- Container management broken: NATS subject mismatch between backend (`root.container.*` / `root.network.*` / `root.volume.*`) and root-worker (`root.docker.container.*` etc.) caused all container create/start/stop/restart/remove/network/volume operations to be silently dropped with "unknown subject" errors.
- `container.inspect` and `container.listAll` incorrectly listed as JetStream stream subjects in the backend, causing sync request-reply messages to be intercepted by the pull consumer instead of the registered subscriber.
- Added missing `root.container.listAll` handler in root-worker to list all Docker containers (used by the "import unmanaged container" feature).

## [1.11.0] - 2026-06-27

### Added
- Settings → System: new admin section showing live host information — hostname, platform, architecture, kernel version, uptime, CPU model and core count with usage bar and 1/5/15-minute load averages, memory usage bar, and network interfaces with per-address IPv4/IPv6 badges and live RX/TX throughput. Metrics refresh every 3 seconds.
- Settings → Disks: RAID arrays now rendered as a visual drive bay — each member disk drawn as an illustrated HDD (platter rings, arm, activity LED) with green/red coloring per active/degraded state, chevrons between drives, and an arrow showing the logical RAID output and mount point. Usage bar appears at the bottom when the array is mounted.

### Fixed
- Activity notifications were displayed twice — once as bottom-right toasts (`NotificationsContainer`) and once in the bell menu. `NotificationsContainer` is now removed; the bell panel is the single source.

## [1.10.2] - 2026-06-27

### Changed
- File browser: folders now require a double-click to navigate into them; single click selects the item (consistent with files). Applies to both list and grid views.
- File browser: activity panel (bell menu) redesigned — uploads and job notifications unified into a single flat list with inline progress bars, replacing the previous two-section card layout.

### Fixed
- File browser: filter bar (Cmd/Ctrl+K) was rendering but hiding the file list due to a Vue v-if chain bug; the filter bar and views are now correctly independent.
- File browser: "Paste" option persisted in the context menu after a copy+paste; clipboard is now always cleared after any paste operation.

## [1.10.1] - 2026-06-27

### Security
- Fixed path traversal in `doZip`: a user-supplied archive name containing `..` or path separators could write the zip file outside the intended destination directory. The name is now sanitized to its base component in the Go worker and rejected by the tRPC input schema before reaching the worker.

## [1.10.0] - 2026-06-27

### Added
- File browser: sort controls on list-view column headers (Name / Size / Modified); directories always sort above files; clicking the active column toggles ascending/descending order.
- File browser: Cmd/Ctrl+K filter bar for real-time name filtering within the current directory; shows match count and dismisses on Escape.
- File browser: "Compress to ZIP" context menu action for any selection (single file, folder, or multi-select); creates a `.zip` archive in the current directory.
- File browser: "Extract Here" context menu action for `.zip` files; extracts to a new subdirectory named after the archive with zip-slip path-traversal protection.
- Settings → Disks: new admin section listing all mounted block-device filesystems with per-disk usage bars (turns yellow >75%, red >90%) and a RAID section that parses `/proc/mdstat` to show array health, level, and member devices.
- Go worker: `root.fs.zip` and `root.fs.unzip` JetStream subjects for async archive creation and extraction, running under user impersonation.
- Go worker: `root.sys.disks` request-reply subject returning mounted filesystems (`/proc/mounts` + `syscall.Statfs`) and RAID array info (`/proc/mdstat`).

### Fixed
- Wallpaper image upload failed for real-world images larger than ~64 KB due to `String.fromCharCode(...largeTypedArray)` exceeding V8's maximum argument count; upload now slices the byte array into 8 KB chunks before base64-encoding.

## [1.9.0] - 2026-06-23

### Added
- Chunked large-file downloads for impersonated users: a new `root.fs.read-chunk` NATS subject reads files in 4 MB slices (mirroring the existing chunked-upload path), and the backend streams those slices directly into the HTTP response via a Node `Readable` — no full-file buffering, no NATS payload limit.

### Fixed
- Impersonated file downloads were silently truncated at 64 MB due to the existing `root.fs.read` NATS payload cap; files larger than that now download completely.
- Worker error replies on the new `read-chunk` subject are now correctly distinguished from raw file bytes via a NATS header, so a mid-stream error aborts the connection instead of silently writing JSON into the downloaded file.
- HTTP `Range` requests (used by video seek) are now properly forwarded through the chunked path, so only the requested byte span is fetched from disk.

## [1.8.2] - 2026-06-23

### Fixed
- File list failed to refresh after async filesystem jobs (rename, delete, move) completed.

## [1.8.1] - 2026-06-23

### Fixed
- Crash in environments where `crypto.randomUUID` is unavailable; the app now falls back to `getRandomValues`.

## [1.8.0] - 2026-06-23

### Added
- `RolePicker` chip+dropdown component: clicking a role chip opens an inline picker to reassign a user's role or a role's member list without navigating away.

### Changed
- User role assignment and role member assignment now use `RolePicker` instead of plain dropdowns.

### Fixed
- Default `readonly` and `readwrite` roles were being seeded on every startup even though they are unused.
- Permission list visual hierarchy in the role editor was inconsistent.

## [1.7.1] - 2026-06-22

### Fixed
- Refresh icon in the unmanaged-containers panel now matches the icon used everywhere else in the app.

## [1.7.0] - 2026-06-21

### Added
- Desktop wallpaper: admins can set a personal background image (uploaded via the new wallpaper picker) or a solid color from the accent palette.
- Background widget grid in desktop mode: dashboard widgets render as a decorative layer behind open windows.
- `User.wallpaper` database column and wallpaper tRPC router; wallpaper images are served via scoped read tokens, not session JWTs.

## [1.6.1] - 2026-06-17

### Fixed
- Global rate limiter was incorrectly applied to the chunked upload route, causing large uploads to be throttled; the upload route is now exempt.

## [1.6.0] - 2026-06-17

### Added
- File preview and editor: double-clicking a file in the browser opens it in-place as an image viewer, video/audio player, or text/code editor with syntax highlighting (CodeMirror 6, language auto-detected from filename). Text files can be edited and saved back.
- Binary detection before opening text files: an 8 KB NUL-byte and UTF-8 replacement-character heuristic prevents garbage bytes from being rendered in the editor.
- Desktop mode: a full windowing environment with draggable/resizable windows, a Dock for open applications, and a Launchpad overlay for launching apps.
- File previews open as first-class desktop windows in desktop mode.

### Fixed
- **Security:** closed a sandbox escape in the Go root-worker where a crafted path containing `..` or a symlink could break out of a Place's allowed root.
- File-preview dirty state is now tracked in a shared store, so minimizing a window via the Dock correctly prompts to save unsaved changes.
- File preview and download URLs now use short-lived scoped tokens instead of embedding the long-lived session JWT in the query string.

## [1.5.0] - 2026-06-17

### Added
- User detail panel with full profile view.
- Pagination for the user list and role list.

## [1.4.0] - 2026-06-16

### Fixed
- Theme-aware colors were missing across file browser components and the user/role management screens; all hardcoded slate colors replaced with CSS design tokens.

## [1.3.0] - 2026-06-16

### Added
- Manual "Check for updates" button in settings.

## [1.2.0] - 2026-06-16

### Added
- Maximum upload size raised to 256 GB.

### Changed
- Application renamed to HSI; database file renamed to `hsi.db`.

### Fixed
- UI contrast, container layout, and unmanaged-containers panel redesigned for clarity.

## [1.1.0] - 2026-06-16

### Added
- Responsive layout that adapts to smaller viewports.

### Removed
- Brand name removed from the main UI chrome.

## [1.0.0] - 2026-06-16

First stable release.

## [0.2.0] - 2026-03-13

### Added
- Unmanaged containers: discover and import containers that were started outside the app.
- Automatic daily update check with an in-app notification when a new version is available.
- Profile settings panel with theme toggle and configurable accent color.
- Neutral gray dark theme; accent color is now user-selectable.

## [0.1.2] - 2026-03-06

### Fixed
- `bcryptjs` was missing from runtime dependencies, breaking password hashing after a clean install.

## [0.1.1] - 2026-03-06

### Fixed
- Database seed now always runs on update to keep default data in sync.
- Database is backed up before running migrations.

## [0.1.0] - 2026-03-06

### Added
- Container management: start, stop, view logs; pin custom endpoints per container.
- Docker Compose YAML import for adding apps.
- Container status polling every 10 seconds.
- System overview panel with CPU, memory, and disk metrics.
- Role editor for fine-grained permission management.

## [0.0.2] - 2026-02-21

### Added
- Upload throughput display with a toggle to switch between single and chunked transfer modes.

## [0.0.1] - 2026-02-19

### Added
- Initial release.

[Unreleased]: https://github.com/kittyruntime/home-server-interface/compare/v1.33.1...HEAD
[1.33.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.33.0...v1.33.1
[1.33.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.32.0...v1.33.0
[1.32.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.31.1...v1.32.0
[1.31.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.31.0...v1.31.1
[1.31.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.30.0...v1.31.0
[1.30.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.29.2...v1.30.0
[1.29.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.29.1...v1.29.2
[1.29.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.29.0...v1.29.1
[1.29.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.6...v1.29.0
[1.28.6]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.5...v1.28.6
[1.28.5]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.4...v1.28.5
[1.28.4]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.3...v1.28.4
[1.28.3]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.2...v1.28.3
[1.28.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.1...v1.28.2
[1.28.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.28.0...v1.28.1
[1.28.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.27.2...v1.28.0
[1.27.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.27.1...v1.27.2
[1.27.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.27.0...v1.27.1
[1.27.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.26.0...v1.27.0
[1.26.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.25.0...v1.26.0
[1.25.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.24.0...v1.25.0
[1.24.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.23.2...v1.24.0
[1.23.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.23.1...v1.23.2
[1.23.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.23.0...v1.23.1
[1.23.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.19.1...v1.20.0
[1.19.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.18.2...v1.19.0
[1.18.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.18.1...v1.18.2
[1.18.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.18.0...v1.18.1
[1.18.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.17.1...v1.18.0
[1.17.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.17.0...v1.17.1
[1.17.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.15.1...v1.16.0
[1.15.1]: https://github.com/kittyruntime/home-server-interface/releases/tag/v1.15.1
[minor]: https://github.com/kittyruntime/home-server-interface/compare/v1.14.0...vminor
[1.14.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.12.3...v1.13.0
[1.12.3]: https://github.com/kittyruntime/home-server-interface/compare/v1.12.2...v1.12.3
[1.12.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.12.1...v1.12.2
[1.12.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.12.0...v1.12.1
[1.12.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.11.5...v1.12.0
[1.11.5]: https://github.com/kittyruntime/home-server-interface/compare/v1.11.4...v1.11.5
[1.11.4]: https://github.com/kittyruntime/home-server-interface/compare/v1.11.3...v1.11.4
[1.11.3]: https://github.com/kittyruntime/home-server-interface/compare/v1.11.2...v1.11.3
[1.11.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.11.1...v1.11.2
[1.11.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.10.2...v1.11.0
[1.10.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.10.1...v1.10.2
[1.10.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/kittyruntime/home-server-interface/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/kittyruntime/home-server-interface/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kittyruntime/home-server-interface/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kittyruntime/home-server-interface/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/kittyruntime/home-server-interface/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/kittyruntime/home-server-interface/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kittyruntime/home-server-interface/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kittyruntime/home-server-interface/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/kittyruntime/home-server-interface/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/kittyruntime/home-server-interface/releases/tag/v0.0.1
