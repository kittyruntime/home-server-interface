# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kittyruntime/home-server-interface/compare/v1.14.0...HEAD
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
