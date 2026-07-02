# SMB Network Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Places as SMB shares via Samba, reusing the existing Place permission model, with NAS-style unified password sync (web / Linux / Samba).

**Architecture:** A new `Share` Prisma model (one per Place), four new NATS request-reply handlers in the Go root-worker (`root.sharing.*`) that own a dedicated `smb.conf` at `/etc/nasui/samba/smb.conf` (activated via a systemd drop-in — **never** touching the samba package's `/etc/samba/smb.conf`, no `dpkg-divert`), a new tRPC `sharing` router that recomputes the full desired Samba state from Place permissions on every mutation, a password hook that pushes plaintext passwords to `chpasswd` + `smbpasswd` at the only moments plaintext exists (create/change/login), and a new admin-only "Sharing" desktop app (Shares + Connections sections).

**Tech Stack:** Go (root-worker, NATS request-reply), Fastify + tRPC + Prisma/SQLite (backend), Vue 3 `<script setup>` + TS + Tailwind v4 tokens (dashboard).

**Spec:** `docs/superpowers/specs/2026-07-02-smb-sharing-design.md`

## Global Constraints

- **No `dpkg-divert`, never modify `/etc/samba/smb.conf`** (package-owned conffile). The only mechanism to redirect smbd is the systemd drop-in `/etc/systemd/system/smbd.service.d/nasui.conf`.
- **No automatic package installation** — `checkPrereqs` detects; the UI shows `apt install samba`; nothing ever runs `apt`.
- **Plaintext passwords are never stored or written to disk** — they flow login/change → NATS → `chpasswd`/`smbpasswd` stdin only. Password sync is always best-effort: a failure must never fail the login / password change / user creation it rides on.
- No test framework exists in this repo (zero `*_test.go` / `*.test.ts` files — confirmed again for this plan). Verification gates: `cd apps/root-worker && go build ./... && go vet ./...`, `cd apps/backend && pnpm exec tsc --noEmit`, `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`, plus a manual pass. Do not introduce a test framework.
- All UI text in English. Vue 3 `<script setup>` + TypeScript strict. tRPC vanilla proxy (`await trpc.x.y.query()`), no `@trpc/vue-query`.
- Design tokens: `.panel-card`, `.badge badge-*`, `.btn btn-*`, `.eyebrow`, `.ui-input`, `font-mono` only for technical values (IPs, paths, linux usernames).
- Commit style: `feat(scope): …` / `fix(scope): …`, one commit per task minimum.
- Prod DB schema is applied with `prisma db push` (see `scripts/install.sh:301`) — **no migration files**; dev uses `cd packages/database && pnpm db:push`.

---

### Task 1: `Share` Prisma model

**Files:**
- Create: `packages/database/prisma/schema/share.prisma`
- Modify: `packages/database/prisma/schema/place.prisma`

**Interfaces:**
- Produces: Prisma model `Share` (`prisma.share.*`) with fields `id: String`, `placeId: String (unique)`, `enabled: Boolean`, `readOnly: Boolean`, `smbName: String | null`, `guestOk: Boolean`, `createdAt`, `updatedAt`, and relation `place: Place`. `Place` gains an optional back-relation `share: Share?`. Later tasks use `prisma.share.findMany({ include: { place: true } })`.

- [ ] **Step 1: Create the schema file**

Create `packages/database/prisma/schema/share.prisma`:

```prisma
model Share {
  id        String   @id @default(uuid())
  placeId   String   @unique
  place     Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)
  enabled   Boolean  @default(true)
  readOnly  Boolean  @default(false)
  smbName   String? // name shown to SMB clients (default: sanitized place.name)
  guestOk   Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 2: Add the back-relation on Place**

In `packages/database/prisma/schema/place.prisma`, change:

```prisma
model Place {
  id              String                @id @default(uuid())
  name            String
  path            String                @unique
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  rolePermissions RolePlacePermission[] @relation("RolePerms")
  userPermissions UserPlacePermission[] @relation("UserPerms")
}
```

to:

```prisma
model Place {
  id              String                @id @default(uuid())
  name            String
  path            String                @unique
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  rolePermissions RolePlacePermission[] @relation("RolePerms")
  userPermissions UserPlacePermission[] @relation("UserPerms")
  share           Share?
}
```

- [ ] **Step 3: Apply and regenerate the client**

Run: `cd packages/database && pnpm db:push`
Expected: `Your database is now in sync with your Prisma schema.` and `✔ Generated Prisma Client` (db push regenerates the client; no migration file is created — this matches how prod applies schema changes via `install.sh`).

- [ ] **Step 4: Verify the backend still type-checks**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema/share.prisma packages/database/prisma/schema/place.prisma
git commit -m "feat(sharing): add Share model (one SMB share per Place)"
```

---

### Task 2: root-worker `root.sharing.*` handlers

**Files:**
- Create: `apps/root-worker/sharing.go`
- Modify: `apps/root-worker/main.go` (subscribe map, around line 824)

**Interfaces:**
- Consumes: existing helpers from `main.go`/`fs.go`: `replyOk(nc, msg.Reply, result)`, `replyErr(nc, msg.Reply, &fsError{Code, Message})`, `reLinuxUsername` regexp.
- Produces (NATS request-reply, JSON envelopes matching `syncResponse`):
  - `root.sharing.checkPrereqs` — input `{}` → result `{ "smbdInstalled": bool }`
  - `root.sharing.sync` — input `{ "shares": [{ "name": string, "path": string, "readOnly": bool, "guestOk": bool, "validUsers": string[], "writeUsers": string[] }] }` → result `{ "ok": true }`. Error code `"SMBD_MISSING"` when smbd is not installed.
  - `root.sharing.setPassword` — input `{ "linuxUsername": string, "password": string }` → result `{ "linuxOk": bool, "smbOk": bool }`
  - `root.sharing.status` — input `{}` → result `{ "connections": [{ "user": string, "share": string, "client": string, "connectedAt": string }] }`. Error code `"SMBD_MISSING"` when smbstatus is not installed.

- [ ] **Step 1: Create `apps/root-worker/sharing.go`**

```go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// SMB sharing handlers. The app owns /etc/nasui/samba/smb.conf and points
// smbd at it through a systemd drop-in — the samba package's own
// /etc/samba/smb.conf is never modified, so apt upgrades stay conflict-free
// (no dpkg-divert, no conffile prompt).
const (
	smbConfDir  = "/etc/nasui/samba"
	smbConfPath = smbConfDir + "/smb.conf"
	dropInDir   = "/etc/systemd/system/smbd.service.d"
	dropInPath  = dropInDir + "/nasui.conf"
)

const dropInContent = `# Managed by nasui — points smbd at the app-owned config instead of the
# samba package's /etc/samba/smb.conf (systemd drop-in, no dpkg-divert).
[Service]
ExecStart=
ExecStart=/usr/sbin/smbd --foreground --no-process-group --configfile=` + smbConfPath + `
`

var reSmbShareName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)

type shareDef struct {
	Name       string   `json:"name"`
	Path       string   `json:"path"`
	ReadOnly   bool     `json:"readOnly"`
	GuestOk    bool     `json:"guestOk"`
	ValidUsers []string `json:"validUsers"`
	WriteUsers []string `json:"writeUsers"`
}

func smbdInstalled() bool {
	if _, err := exec.LookPath("smbd"); err == nil {
		return true
	}
	_, err := os.Stat("/usr/sbin/smbd")
	return err == nil
}

func handleSharingCheckPrereqs(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"smbdInstalled": smbdInstalled()})
}

// ensureDropIn installs the systemd drop-in once. Returns true when it was
// just created (caller must daemon-reload + restart instead of reload).
func ensureDropIn() (bool, error) {
	if _, err := os.Stat(dropInPath); err == nil {
		return false, nil
	}
	if err := os.MkdirAll(dropInDir, 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(dropInPath, []byte(dropInContent), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func renderSmbConf(shares []shareDef) (string, error) {
	var b strings.Builder
	b.WriteString("# Managed by nasui root-worker — do not edit; regenerated on every sync.\n")
	b.WriteString("[global]\n")
	b.WriteString("   server role = standalone server\n")
	b.WriteString("   server min protocol = SMB2\n")
	b.WriteString("   map to guest = Bad User\n")
	b.WriteString("   load printers = no\n")
	b.WriteString("   printing = bsd\n")
	b.WriteString("   disable spoolss = yes\n")
	sorted := append([]shareDef(nil), shares...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	for _, s := range sorted {
		if !reSmbShareName.MatchString(s.Name) {
			return "", fmt.Errorf("invalid share name %q", s.Name)
		}
		if !filepath.IsAbs(s.Path) || strings.ContainsAny(s.Path, "\n\r") {
			return "", fmt.Errorf("invalid share path %q", s.Path)
		}
		for _, u := range append(append([]string(nil), s.ValidUsers...), s.WriteUsers...) {
			if !reLinuxUsername.MatchString(u) {
				return "", fmt.Errorf("invalid username %q in share %q", u, s.Name)
			}
		}
		b.WriteString("\n[" + s.Name + "]\n")
		b.WriteString("   path = " + s.Path + "\n")
		b.WriteString("   browseable = yes\n")
		// Writes are granted exclusively through "write list" — the share
		// itself always stays "read only = yes".
		b.WriteString("   read only = yes\n")
		if s.GuestOk {
			b.WriteString("   guest ok = yes\n")
		} else if len(s.ValidUsers) > 0 {
			b.WriteString("   valid users = " + strings.Join(s.ValidUsers, " ") + "\n")
		} else {
			// An empty "valid users" list means "everyone" to Samba — a share
			// with no permitted users and no guest access must be disabled.
			b.WriteString("   available = no\n")
		}
		if !s.ReadOnly && len(s.WriteUsers) > 0 {
			b.WriteString("   write list = " + strings.Join(s.WriteUsers, " ") + "\n")
		}
	}
	return b.String(), nil
}

func handleSharingSync(nc *nats.Conn, msg *nats.Msg) {
	if !smbdInstalled() {
		replyErr(nc, msg.Reply, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"})
		return
	}
	var req struct {
		Shares []shareDef `json:"shares"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	conf, err := renderSmbConf(req.Shares)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	created, err := ensureDropIn()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "install drop-in: " + err.Error()})
		return
	}
	if err := os.MkdirAll(smbConfDir, 0o755); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	tmp := smbConfPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(conf), 0o644); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := os.Rename(tmp, smbConfPath); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if created {
		if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
			return
		}
		exec.Command("systemctl", "enable", "--quiet", "smbd").Run()
		if out, err := exec.Command("systemctl", "restart", "smbd").CombinedOutput(); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "restart smbd: " + strings.TrimSpace(string(out))})
			return
		}
	} else {
		exec.Command("systemctl", "enable", "--quiet", "smbd").Run()
		if out, err := exec.Command("systemctl", "reload-or-restart", "smbd").CombinedOutput(); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "reload smbd: " + strings.TrimSpace(string(out))})
			return
		}
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleSharingSetPassword(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		LinuxUsername string `json:"linuxUsername"`
		Password      string `json:"password"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	if !reLinuxUsername.MatchString(req.LinuxUsername) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid linux username"})
		return
	}
	if req.Password == "" || strings.ContainsAny(req.Password, "\n\r") {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid password"})
		return
	}
	// Linux system password. The account keeps its /sbin/nologin shell (see
	// handleLinuxUserCreate), so this grants no shell/SSH access — it only
	// keeps web/Linux/Samba passwords consistent, NAS-style.
	linuxOk := true
	chp := exec.Command("chpasswd")
	chp.Stdin = strings.NewReader(req.LinuxUsername + ":" + req.Password + "\n")
	if err := chp.Run(); err != nil {
		linuxOk = false
	}
	smbOk := false
	if _, err := exec.LookPath("smbpasswd"); err == nil {
		smb := exec.Command("smbpasswd", "-s", "-a", req.LinuxUsername)
		smb.Stdin = strings.NewReader(req.Password + "\n" + req.Password + "\n")
		smbOk = smb.Run() == nil
	}
	replyOk(nc, msg.Reply, map[string]any{"linuxOk": linuxOk, "smbOk": smbOk})
}

func handleSharingStatus(nc *nats.Conn, msg *nats.Msg) {
	if _, err := exec.LookPath("smbstatus"); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"})
		return
	}
	out, err := exec.Command("smbstatus", "--json").Output()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "smbstatus failed: " + err.Error()})
		return
	}
	var raw struct {
		Sessions map[string]struct {
			Username      string `json:"username"`
			RemoteMachine string `json:"remote_machine"`
			Hostname      string `json:"hostname"`
		} `json:"sessions"`
		Tcons map[string]struct {
			Service     string `json:"service"`
			SessionID   string `json:"session_id"`
			Machine     string `json:"machine"`
			ConnectedAt string `json:"connected_at"`
		} `json:"tcons"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "unexpected smbstatus output"})
		return
	}
	type connection struct {
		User        string `json:"user"`
		Share       string `json:"share"`
		Client      string `json:"client"`
		ConnectedAt string `json:"connectedAt"`
	}
	connections := []connection{}
	for _, t := range raw.Tcons {
		if t.Service == "IPC$" {
			continue
		}
		c := connection{Share: t.Service, Client: t.Machine, ConnectedAt: t.ConnectedAt}
		if s, ok := raw.Sessions[t.SessionID]; ok {
			c.User = s.Username
			if c.Client == "" {
				c.Client = s.RemoteMachine
			}
		}
		connections = append(connections, c)
	}
	replyOk(nc, msg.Reply, map[string]any{"connections": connections})
}
```

- [ ] **Step 2: Register the handlers**

In `apps/root-worker/main.go`, in the request-reply subscription map (the `for subj, handler := range map[string]func(*nats.Conn, *nats.Msg){` block around line 795), add after `"root.fs.search": handleSearch,`:

```go
		"root.sharing.checkPrereqs":        handleSharingCheckPrereqs,
		"root.sharing.sync":                handleSharingSync,
		"root.sharing.setPassword":         handleSharingSetPassword,
		"root.sharing.status":              handleSharingStatus,
```

- [ ] **Step 3: Build and vet**

Run: `cd apps/root-worker && go build ./... && go vet ./...`
Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add apps/root-worker/sharing.go apps/root-worker/main.go
git commit -m "feat(sharing): add root.sharing.* worker handlers (smb.conf sync, password, status, prereqs)"
```

---

### Task 3: backend sharing service + tRPC router + permission-change hooks

**Files:**
- Create: `apps/backend/src/services/sharing.service.ts`
- Create: `apps/backend/src/trpc/routers/sharing.ts`
- Modify: `apps/backend/src/trpc/routers/index.ts`
- Modify: `apps/backend/src/trpc/routers/permission.ts`
- Modify: `apps/backend/src/trpc/routers/role.ts` (procedures `assignUser` line ~75, `removeUser` line ~91)
- Modify: `apps/backend/src/trpc/routers/place.ts` (procedure `delete` line ~75)
- Modify: `apps/backend/src/trpc/routers/user.ts` (procedure `update` line ~26, `delete` line ~72)

**Interfaces:**
- Consumes: `requestSync<T>(subject, payload)` from `apps/backend/src/nats.ts`; Prisma `Share` from Task 1; worker subjects/payloads from Task 2 (worker errors carry `code: "SMBD_MISSING"` via `Object.assign(new Error(...), { code })` in `requestSync`).
- Produces:
  - `sharing.service.ts`: `resolveShareUsers(prisma, placeId) => Promise<{ validUsers: string[]; writeUsers: string[]; excludedUsernames: string[] }>`, `effectiveSmbName(share: { smbName: string | null }, placeName: string) => string`, `syncShares(prisma) => Promise<void>` (throws), `syncSharesBestEffort(prisma) => Promise<void>` (never throws).
  - tRPC procedures under `trpc.sharing.*`: `checkPrereqs` (query → `{ smbdInstalled: boolean }`), `list` (query → array of `{ id, placeId, placeName, placePath, enabled, readOnly, guestOk, smbName, effectiveName, userCount, excludedUsernames }`), `create` / `update` / `remove` (mutations), `status` (query → `{ connections: { user, share, client, connectedAt }[] }`).

- [ ] **Step 1: Create `apps/backend/src/services/sharing.service.ts`**

```ts
import type { PrismaClient } from "@app/database"
import { requestSync } from "../nats"

export interface ResolvedShareUsers {
  validUsers: string[]
  writeUsers: string[]
  /** App usernames that have access to the Place but no linuxUsername — they
   *  cannot get a Samba account and are excluded from the effective share. */
  excludedUsernames: string[]
}

/** Aggregates UserPlacePermission + RolePlacePermission for a Place — same
 *  read/write semantics as the rest of the app — into Samba user lists. */
export async function resolveShareUsers(
  prisma: PrismaClient,
  placeId: string,
): Promise<ResolvedShareUsers> {
  const [userPerms, rolePerms] = await Promise.all([
    prisma.userPlacePermission.findMany({
      where: { placeId, canRead: true },
      select: {
        canWrite: true,
        user: { select: { username: true, linuxUsername: true } },
      },
    }),
    prisma.rolePlacePermission.findMany({
      where: { placeId, canRead: true },
      select: {
        canWrite: true,
        role: {
          select: {
            userRoles: {
              select: { user: { select: { username: true, linuxUsername: true } } },
            },
          },
        },
      },
    }),
  ])

  const byUsername = new Map<string, { linux: string | null; write: boolean }>()
  const add = (u: { username: string; linuxUsername: string | null }, write: boolean) => {
    const cur = byUsername.get(u.username)
    if (cur) cur.write = cur.write || write
    else byUsername.set(u.username, { linux: u.linuxUsername, write })
  }
  for (const p of userPerms) add(p.user, p.canWrite)
  for (const p of rolePerms) for (const ur of p.role.userRoles) add(ur.user, p.canWrite)

  const validUsers: string[] = []
  const writeUsers: string[] = []
  const excludedUsernames: string[] = []
  for (const [username, info] of byUsername) {
    if (!info.linux) {
      excludedUsernames.push(username)
      continue
    }
    validUsers.push(info.linux)
    if (info.write) writeUsers.push(info.linux)
  }
  validUsers.sort()
  writeUsers.sort()
  excludedUsernames.sort()
  return { validUsers, writeUsers, excludedUsernames }
}

function sanitizeSmbName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 32)
  return cleaned || "share"
}

export function effectiveSmbName(
  share: { smbName: string | null },
  placeName: string,
): string {
  return share.smbName ?? sanitizeSmbName(placeName)
}

/** Pushes the complete desired SMB state to the root-worker. Samba always
 *  reflects the current DB/permission state — no incremental diffing. */
export async function syncShares(prisma: PrismaClient): Promise<void> {
  const shares = await prisma.share.findMany({
    where: { enabled: true },
    include: { place: { select: { name: true, path: true } } },
  })
  const defs = []
  for (const s of shares) {
    const users = await resolveShareUsers(prisma, s.placeId)
    defs.push({
      name: effectiveSmbName(s, s.place.name),
      path: s.place.path,
      readOnly: s.readOnly,
      guestOk: s.guestOk,
      validUsers: users.validUsers,
      writeUsers: s.readOnly ? [] : users.writeUsers,
    })
  }
  await requestSync("root.sharing.sync", { shares: defs })
}

/** For hooks riding on unrelated mutations (permission edits, role
 *  assignments…): sharing must never break those flows. */
export async function syncSharesBestEffort(prisma: PrismaClient): Promise<void> {
  try {
    await syncShares(prisma)
  } catch (e) {
    console.warn("[sharing] sync failed (non-fatal):", e)
  }
}
```

- [ ] **Step 2: Create `apps/backend/src/trpc/routers/sharing.ts`**

```ts
import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { router, adminProcedure } from "../index"
import { requestSync } from "../../nats"
import {
  resolveShareUsers,
  effectiveSmbName,
  syncShares,
} from "../../services/sharing.service"

const reSmbName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

type ShareConnection = { user: string; share: string; client: string; connectedAt: string }

function throwSyncError(e: unknown): never {
  if ((e as { code?: string })?.code === "SMBD_MISSING") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Samba is not installed on the host. Run: apt install samba",
    })
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: (e as Error)?.message ?? "Share sync failed",
  })
}

async function assertUniqueName(
  prisma: Parameters<typeof syncShares>[0],
  name: string,
  excludeShareId?: string,
): Promise<void> {
  const others = await prisma.share.findMany({
    where: excludeShareId ? { id: { not: excludeShareId } } : {},
    include: { place: { select: { name: true } } },
  })
  const taken = others.some(
    (s) => effectiveSmbName(s, s.place.name).toLowerCase() === name.toLowerCase(),
  )
  if (taken)
    throw new TRPCError({ code: "CONFLICT", message: `Share name "${name}" is already in use` })
}

export const sharingRouter = router({
  checkPrereqs: adminProcedure.query(() =>
    requestSync<{ smbdInstalled: boolean }>("root.sharing.checkPrereqs", {}),
  ),

  list: adminProcedure.query(async ({ ctx }) => {
    const shares = await ctx.prisma.share.findMany({
      include: { place: { select: { id: true, name: true, path: true } } },
      orderBy: { createdAt: "asc" },
    })
    return Promise.all(
      shares.map(async (s) => {
        const users = await resolveShareUsers(ctx.prisma, s.placeId)
        return {
          id: s.id,
          placeId: s.placeId,
          placeName: s.place.name,
          placePath: s.place.path,
          enabled: s.enabled,
          readOnly: s.readOnly,
          guestOk: s.guestOk,
          smbName: s.smbName,
          effectiveName: effectiveSmbName(s, s.place.name),
          userCount: users.validUsers.length,
          excludedUsernames: users.excludedUsernames,
        }
      }),
    )
  }),

  create: adminProcedure
    .input(
      z.object({
        placeId: z.string(),
        smbName: z.string().regex(reSmbName).optional(),
        readOnly: z.boolean().default(false),
        guestOk: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const place = await ctx.prisma.place.findUnique({ where: { id: input.placeId } })
      if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" })
      const existing = await ctx.prisma.share.findUnique({ where: { placeId: input.placeId } })
      if (existing)
        throw new TRPCError({ code: "CONFLICT", message: "This place is already shared" })
      const name = effectiveSmbName({ smbName: input.smbName ?? null }, place.name)
      await assertUniqueName(ctx.prisma, name)

      const share = await ctx.prisma.share.create({
        data: {
          placeId: input.placeId,
          smbName: input.smbName ?? null,
          readOnly: input.readOnly,
          guestOk: input.guestOk,
        },
      })
      try {
        await syncShares(ctx.prisma)
      } catch (e) {
        // Roll the row back so the UI never shows a share Samba doesn't have.
        await ctx.prisma.share.delete({ where: { id: share.id } }).catch(() => {})
        throwSyncError(e)
      }
      return share
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string(),
        enabled: z.boolean().optional(),
        readOnly: z.boolean().optional(),
        guestOk: z.boolean().optional(),
        smbName: z.string().regex(reSmbName).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const share = await ctx.prisma.share.findUnique({
        where: { id: input.id },
        include: { place: { select: { name: true } } },
      })
      if (!share) throw new TRPCError({ code: "NOT_FOUND", message: "Share not found" })
      if (input.smbName !== undefined) {
        const name = effectiveSmbName({ smbName: input.smbName }, share.place.name)
        await assertUniqueName(ctx.prisma, name, share.id)
      }
      const updated = await ctx.prisma.share.update({
        where: { id: input.id },
        data: {
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.readOnly !== undefined && { readOnly: input.readOnly }),
          ...(input.guestOk !== undefined && { guestOk: input.guestOk }),
          ...(input.smbName !== undefined && { smbName: input.smbName }),
        },
      })
      try {
        await syncShares(ctx.prisma)
      } catch (e) {
        throwSyncError(e)
      }
      return updated
    }),

  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.share.delete({ where: { id: input.id } })
      try {
        await syncShares(ctx.prisma)
      } catch (e) {
        // Row is gone; if Samba is missing there is nothing to clean up.
        if ((e as { code?: string })?.code !== "SMBD_MISSING") throwSyncError(e)
      }
      return { ok: true }
    }),

  status: adminProcedure.query(async () => {
    try {
      return await requestSync<{ connections: ShareConnection[] }>("root.sharing.status", {})
    } catch (e) {
      if ((e as { code?: string })?.code === "SMBD_MISSING") return { connections: [] }
      throw e
    }
  }),
})
```

- [ ] **Step 3: Register the router**

In `apps/backend/src/trpc/routers/index.ts`, add the import and entry:

```ts
import { sharingRouter } from "./sharing"
```

and inside `router({ … })`, after `audit: auditRouter,`:

```ts
  sharing: sharingRouter,
```

- [ ] **Step 4: Hook share re-sync into permission mutations**

Samba must follow Place permissions ("recomputed on every sync" — spec Section 3). In `apps/backend/src/trpc/routers/permission.ts`:

Add the import at the top:

```ts
import { syncSharesBestEffort } from "../../services/sharing.service"
```

Change `upsert`'s mutation body — currently it `return`s the upsert directly in both branches. Replace the body of `.mutation(async ({ ctx, input }) => { … })` with:

```ts
    .mutation(async ({ ctx, input }) => {
      const result =
        input.subjectType === "role"
          ? await ctx.prisma.rolePlacePermission.upsert({
              where: { roleId_placeId: { roleId: input.subjectId, placeId: input.placeId } },
              update: { canRead: input.canRead, canWrite: input.canWrite, canDelete: input.canDelete },
              create: {
                roleId: input.subjectId,
                placeId: input.placeId,
                canRead: input.canRead,
                canWrite: input.canWrite,
                canDelete: input.canDelete,
              },
            })
          : await ctx.prisma.userPlacePermission.upsert({
              where: { userId_placeId: { userId: input.subjectId, placeId: input.placeId } },
              update: { canRead: input.canRead, canWrite: input.canWrite, canDelete: input.canDelete },
              create: {
                userId: input.subjectId,
                placeId: input.placeId,
                canRead: input.canRead,
                canWrite: input.canWrite,
                canDelete: input.canDelete,
              },
            })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
```

Change `remove`'s mutation body the same way:

```ts
    .mutation(async ({ ctx, input }) => {
      const result =
        input.subjectType === "role"
          ? await ctx.prisma.rolePlacePermission.deleteMany({
              where: { roleId: input.subjectId, placeId: input.placeId },
            })
          : await ctx.prisma.userPlacePermission.deleteMany({
              where: { userId: input.subjectId, placeId: input.placeId },
            })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
```

- [ ] **Step 5: Hook share re-sync into role membership, place deletion, and user changes**

Role membership changes the resolved user set of role-permitted shares. In `apps/backend/src/trpc/routers/role.ts`, add the import:

```ts
import { syncSharesBestEffort } from "../../services/sharing.service"
```

In `assignUser` (line ~75), change the final statement from:

```ts
      return ctx.prisma.userRole.upsert({
        where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
        update: {},
        create: { userId: input.userId, roleId: input.roleId },
      })
```

to:

```ts
      const result = await ctx.prisma.userRole.upsert({
        where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
        update: {},
        create: { userId: input.userId, roleId: input.roleId },
      })
      void syncSharesBestEffort(ctx.prisma)
      return result
```

In `removeUser` (line ~91), change the mutation from:

```ts
    .mutation(({ ctx, input }) => {
      if (input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot remove roles from yourself" })
      return ctx.prisma.userRole.delete({
        where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
      })
    }),
```

to:

```ts
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.userId)
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot remove roles from yourself" })
      const result = await ctx.prisma.userRole.delete({
        where: { userId_roleId: { userId: input.userId, roleId: input.roleId } },
      })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
```

In `apps/backend/src/trpc/routers/place.ts`, add the same import, then change `delete` (line ~75) from:

```ts
  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      return ctx.prisma.place.delete({ where: { id: input.id } })
    }),
```

to:

```ts
  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Cascade removes the Place's Share row; the follow-up sync drops it
      // from Samba as well.
      const result = await ctx.prisma.place.delete({ where: { id: input.id } })
      void syncSharesBestEffort(ctx.prisma)
      return result
    }),
```

In `apps/backend/src/trpc/routers/user.ts`, add the same import. In `update` (line ~26), after the existing `return ctx.prisma.user.update({ … })` statement, change it to capture-then-sync (a `linuxUsername` change alters the effective Samba user list):

```ts
      const result = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: {
          ...(input.displayName  !== undefined && { displayName:  input.displayName }),
          ...(input.linuxUsername !== undefined && { linuxUsername: input.linuxUsername }),
        },
        select: userSelect,
      })
      if (input.linuxUsername !== undefined) void syncSharesBestEffort(ctx.prisma)
      return result
```

In `delete` (line ~72), change the final `return ctx.prisma.user.delete({ where: { id: input.userId } })` to:

```ts
      const result = await ctx.prisma.user.delete({ where: { id: input.userId } })
      void syncSharesBestEffort(ctx.prisma)
      return result
```

- [ ] **Step 6: Type-check**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/services/sharing.service.ts apps/backend/src/trpc/routers/sharing.ts apps/backend/src/trpc/routers/index.ts apps/backend/src/trpc/routers/permission.ts apps/backend/src/trpc/routers/role.ts apps/backend/src/trpc/routers/place.ts apps/backend/src/trpc/routers/user.ts
git commit -m "feat(sharing): add sharing service, tRPC router, and permission-change re-sync hooks"
```

---

### Task 4: NAS-style unified password sync (web → Linux → Samba)

**Files:**
- Modify: `apps/backend/src/services/user.service.ts`
- Modify: `apps/backend/src/services/auth.service.ts`

**Interfaces:**
- Consumes: `root.sharing.setPassword` (Task 2) via `requestSync` (already imported in `user.service.ts`).
- Produces: `syncSystemPassword(prisma, userId, plainPassword) => Promise<void>` exported from `user.service.ts` — always best-effort, never throws.

- [ ] **Step 1: Add `syncSystemPassword` to `user.service.ts`**

Append at the end of `apps/backend/src/services/user.service.ts`:

```ts
/** NAS-style single password: pushes the plaintext to the root-worker which
 *  sets it on the Linux account (chpasswd — shell stays /sbin/nologin, no
 *  login access) and the Samba account (smbpasswd). Called at the only
 *  moments plaintext exists: user creation, password change, and login
 *  (login backfills accounts that predate this feature). Best-effort by
 *  design — a sync failure must never break the calling flow. */
export async function syncSystemPassword(
  prisma: PrismaClient,
  userId: string,
  plainPassword: string,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { linuxUsername: true },
    })
    if (!user?.linuxUsername) return
    await requestSync("root.sharing.setPassword", {
      linuxUsername: user.linuxUsername,
      password: plainPassword,
    })
  } catch (e) {
    console.warn("[password-sync] failed (non-fatal):", e)
  }
}
```

- [ ] **Step 2: Hook user creation**

In `createUser` (same file), the Linux provisioning block currently reads:

```ts
  if (linuxUsername) {
    try {
      await requestSync("root.linux.user.create", { username: linuxUsername })
    } catch (e) {
      console.warn("[user.create] Linux user creation failed (non-fatal):", e)
    }
  }
```

Change it to also push the initial password once the account exists:

```ts
  if (linuxUsername) {
    try {
      await requestSync("root.linux.user.create", { username: linuxUsername })
      await syncSystemPassword(prisma, user.id, input.password)
    } catch (e) {
      console.warn("[user.create] Linux user creation failed (non-fatal):", e)
    }
  }
```

- [ ] **Step 3: Hook password change**

In `changePassword` (same file), change the final statement from:

```ts
  const newHashed = await bcrypt.hash(newPassword, 12)
  return prisma.user.update({
    where: { id: userId },
    data: { password: newHashed },
    select: { id: true, username: true },
  })
```

to:

```ts
  const newHashed = await bcrypt.hash(newPassword, 12)
  const result = await prisma.user.update({
    where: { id: userId },
    data: { password: newHashed },
    select: { id: true, username: true },
  })
  void syncSystemPassword(prisma, userId, newPassword)
  return result
```

- [ ] **Step 4: Hook login (backfill)**

In `apps/backend/src/services/auth.service.ts`, add the import:

```ts
import { syncSystemPassword } from "./user.service"
```

In `loginUser`, after the credential check succeeds (right after the `if (!user || !(await bcrypt.compare(...)))` block), add:

```ts
  // Fire-and-forget: keeps Linux/Samba passwords in sync for accounts that
  // never changed their password since the sharing feature shipped.
  void syncSystemPassword(prisma, user.id, password)
```

(the existing `select` in `loginUser` already includes `id: true`).

- [ ] **Step 5: Type-check**

Run: `cd apps/backend && pnpm exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/user.service.ts apps/backend/src/services/auth.service.ts
git commit -m "feat(sharing): sync web password to Linux and Samba accounts (NAS-style single password)"
```

---

### Task 5: "Sharing" desktop app (Shares + Connections) and changelog

**Files:**
- Modify: `apps/dashboard/src/lib/desktop.ts`
- Modify: `apps/dashboard/src/components/desktop/Launchpad.vue`
- Modify: `apps/dashboard/src/components/desktop/DesktopWindow.vue`
- Create: `apps/dashboard/src/components/sharing/SharingPanel.vue`
- Create: `apps/dashboard/src/components/sharing/SharesSection.vue`
- Create: `apps/dashboard/src/components/sharing/ConnectionsSection.vue`
- Modify: `CHANGELOG.md` (`[Unreleased]` section)

**Interfaces:**
- Consumes: `trpc.sharing.checkPrereqs/list/create/update/remove/status` from Task 3, `trpc.place.list`; shared `Modal.vue` (`panel-class` prop, `#header`/`#footer` slots, `close` emit); design classes `.panel-card`, `.badge`, `.btn`, `.eyebrow`, `.ui-input`, `font-mono`.
- Produces: new `AppId` value `'sharing'`; `SharingPanel.vue` default export used by `DesktopWindow.vue`.

- [ ] **Step 1: Register the app id in `apps/dashboard/src/lib/desktop.ts`**

Change the `AppId` union (line 4):

```ts
export type AppId = 'files' | 'apps' | 'settings' | 'storage' | 'monitor' | 'sharing' | 'file-preview'
```

Add to `APP_LABEL` (after `monitor: 'Monitor',`):

```ts
  sharing: 'Sharing',
```

Add to `APP_ICON_PATH` (after the `monitor` entry — heroicons "share" outline):

```ts
  sharing: 'M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z',
```

Add to `DEFAULT_SIZE` (after the `monitor` entry):

```ts
  sharing: { w: 860, h: 560 },
```

- [ ] **Step 2: Add the Launchpad entry**

In `apps/dashboard/src/components/desktop/Launchpad.vue`, in `allApps` (line 10), insert after the `monitor` line:

```ts
  { id: 'sharing', adminOnly: true },
```

- [ ] **Step 3: Route the window content**

In `apps/dashboard/src/components/desktop/DesktopWindow.vue`, add the import next to `MonitorPanel` (line 10):

```ts
import SharingPanel from '../sharing/SharingPanel.vue'
```

and in the template, after the `MonitorPanel` line (line 207):

```html
      <SharingPanel v-else-if="win.appId === 'sharing'" class="h-full" />
```

- [ ] **Step 4: Create `apps/dashboard/src/components/sharing/SharingPanel.vue`**

Mirrors `MonitorPanel.vue`'s two-column layout:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import SharesSection from './SharesSection.vue'
import ConnectionsSection from './ConnectionsSection.vue'

type SectionId = 'shares' | 'connections'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'shares',      label: 'Shares' },
  { id: 'connections', label: 'Connections' },
]

const active = ref<SectionId>('shares')
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <!-- Mobile picker -->
    <div class="sm:hidden flex-shrink-0 border-b border-[var(--c-border)] bg-[var(--c-sidebar)] px-4 py-2.5">
      <select v-model="active" class="w-full bg-transparent text-sm text-[var(--c-text-2)] focus:outline-none">
        <option v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>

    <!-- Left nav -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
        <span
          v-if="active === item.id"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--c-accent)] rounded-r-full"
        />
        <button
          @click="active = item.id"
          :class="[
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
            active === item.id
              ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
              : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
          ]"
        >
          <!-- Shares -->
          <svg v-if="item.id === 'shares'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
          </svg>
          <!-- Connections -->
          <svg v-else-if="item.id === 'connections'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"/>
          </svg>
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-8 max-w-4xl">
        <SharesSection      v-if="active === 'shares'" />
        <ConnectionsSection v-else-if="active === 'connections'" />
      </div>
    </div>

  </div>
</template>
```

- [ ] **Step 5: Create `apps/dashboard/src/components/sharing/SharesSection.vue`**

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'

type ShareRow = {
  id: string
  placeId: string
  placeName: string
  placePath: string
  enabled: boolean
  readOnly: boolean
  guestOk: boolean
  smbName: string | null
  effectiveName: string
  userCount: number
  excludedUsernames: string[]
}

type PlaceRow = { id: string; name: string; path: string }

const prereq  = ref<{ smbdInstalled: boolean } | null>(null)
const shares  = ref<ShareRow[]>([])
const places  = ref<PlaceRow[]>([])
const loading = ref(true)
const error   = ref('')

// null = closed; { id: null } = create; { id: string } = edit
const editor = ref<{
  id: string | null
  placeId: string
  smbName: string
  readOnly: boolean
  guestOk: boolean
} | null>(null)
const saving      = ref(false)
const editorError = ref('')
const deleting    = ref<string | null>(null)

const availablePlaces = computed(() => {
  const sharedIds = new Set(shares.value.map(s => s.placeId))
  return places.value.filter(p => !sharedIds.has(p.id))
})

async function refresh() {
  error.value = ''
  try {
    const [p, s, pl] = await Promise.all([
      trpc.sharing.checkPrereqs.query(),
      trpc.sharing.list.query(),
      trpc.place.list.query(),
    ])
    prereq.value = p
    shares.value = s
    places.value = pl as PlaceRow[]
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load shares'
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

function openCreate() {
  editorError.value = ''
  editor.value = {
    id: null,
    placeId: availablePlaces.value[0]?.id ?? '',
    smbName: '',
    readOnly: false,
    guestOk: false,
  }
}

function openEdit(s: ShareRow) {
  editorError.value = ''
  editor.value = {
    id: s.id,
    placeId: s.placeId,
    smbName: s.smbName ?? '',
    readOnly: s.readOnly,
    guestOk: s.guestOk,
  }
}

async function save() {
  if (!editor.value) return
  saving.value = true
  editorError.value = ''
  try {
    if (editor.value.id === null) {
      await trpc.sharing.create.mutate({
        placeId: editor.value.placeId,
        smbName: editor.value.smbName.trim() || undefined,
        readOnly: editor.value.readOnly,
        guestOk: editor.value.guestOk,
      })
    } else {
      await trpc.sharing.update.mutate({
        id: editor.value.id,
        smbName: editor.value.smbName.trim() || null,
        readOnly: editor.value.readOnly,
        guestOk: editor.value.guestOk,
      })
    }
    editor.value = null
    await refresh()
  } catch (e: unknown) {
    editorError.value = (e as { message?: string })?.message ?? 'Failed to save share'
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(s: ShareRow) {
  error.value = ''
  try {
    await trpc.sharing.update.mutate({ id: s.id, enabled: !s.enabled })
    await refresh()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to update share'
  }
}

async function removeShare(s: ShareRow) {
  if (!confirm(`Stop sharing "${s.effectiveName}"? Clients will lose access.`)) return
  deleting.value = s.id
  error.value = ''
  try {
    await trpc.sharing.remove.mutate({ id: s.id })
    await refresh()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to delete share'
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <p class="eyebrow mb-1">Network sharing</p>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">SMB shares</h2>
      </div>
      <button
        v-if="prereq?.smbdInstalled && availablePlaces.length > 0"
        class="btn btn-primary btn-sm"
        @click="openCreate"
      >
        New share
      </button>
    </div>

    <p v-if="error" class="status-text text-[var(--c-danger)] mb-4">[ERR] {{ error }}</p>

    <div v-if="loading" class="text-sm text-[var(--c-text-3)]">Loading…</div>

    <!-- Samba missing: guide, never a cryptic error -->
    <div v-else-if="prereq && !prereq.smbdInstalled" class="panel-card bg-[var(--c-surface)] p-6">
      <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-2">Samba is not installed</h3>
      <p class="text-sm text-[var(--c-text-2)] mb-4">
        SMB sharing needs the Samba server on the host. Install it, then come back here — nothing else to configure.
      </p>
      <code class="inline-block px-3 py-2 rounded-lg bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)] text-sm font-mono text-[var(--c-text-1)]">
        sudo apt install samba
      </code>
      <div class="mt-4">
        <button class="btn btn-outline btn-sm" @click="refresh">Check again</button>
      </div>
    </div>

    <div v-else-if="shares.length === 0" class="panel-card bg-[var(--c-surface)] p-6 text-sm text-[var(--c-text-3)]">
      No shares yet. Share an existing place to make it reachable from Windows Explorer, Finder, or any SMB client.
    </div>

    <div v-else class="space-y-3">
      <div v-for="s in shares" :key="s.id" class="panel-card bg-[var(--c-surface)] p-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-[var(--c-text-1)]">{{ s.effectiveName }}</span>
              <span :class="['badge', s.enabled ? 'badge-accent' : 'badge-muted']">
                {{ s.enabled ? 'Active' : 'Disabled' }}
              </span>
              <span v-if="s.readOnly" class="badge badge-muted">Read-only</span>
              <span v-if="s.guestOk" class="badge badge-muted">Guest</span>
            </div>
            <p class="text-xs text-[var(--c-text-3)] mt-1">
              {{ s.placeName }} · <span class="font-mono">{{ s.placePath }}</span> · {{ s.userCount }} user{{ s.userCount === 1 ? '' : 's' }}
            </p>
            <p v-if="s.excludedUsernames.length > 0" class="status-text text-[var(--c-warning)] mt-2">
              [WARN] No Linux account for {{ s.excludedUsernames.join(', ') }} — excluded from this share
            </p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button class="btn btn-ghost btn-xs" @click="toggleEnabled(s)">
              {{ s.enabled ? 'Disable' : 'Enable' }}
            </button>
            <button class="btn btn-ghost btn-xs" @click="openEdit(s)">Edit</button>
            <button class="btn btn-danger btn-xs" :disabled="deleting === s.id" @click="removeShare(s)">
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create / edit modal -->
    <Modal v-if="editor" panel-class="w-full max-w-sm" @close="editor = null">
      <template #header>
        <h3 class="text-sm font-semibold text-[var(--c-text-1)]">
          {{ editor.id === null ? 'New share' : 'Edit share' }}
        </h3>
      </template>

      <div class="p-6 space-y-4">
        <div v-if="editor.id === null">
          <p class="eyebrow mb-2">Place</p>
          <select v-model="editor.placeId" class="ui-input w-full">
            <option v-for="p in availablePlaces" :key="p.id" :value="p.id">
              {{ p.name }} — {{ p.path }}
            </option>
          </select>
        </div>

        <div>
          <p class="eyebrow mb-2">Share name</p>
          <input
            v-model="editor.smbName"
            type="text"
            placeholder="Defaults to the place name"
            class="ui-input w-full font-mono"
          />
          <p class="text-xs text-[var(--c-text-3)] mt-1">Letters, digits, dots, dashes, underscores. Max 32 characters.</p>
        </div>

        <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
          <input v-model="editor.readOnly" type="checkbox" />
          Read-only (ignore write permissions)
        </label>
        <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
          <input v-model="editor.guestOk" type="checkbox" />
          Allow guest access (no authentication)
        </label>

        <p v-if="editorError" class="status-text text-[var(--c-danger)]">[ERR] {{ editorError }}</p>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-sm" @click="editor = null">Cancel</button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="saving || (editor.id === null && !editor.placeId)"
            @click="save"
          >
            {{ saving ? 'Saving…' : editor.id === null ? 'Create share' : 'Save' }}
          </button>
        </div>
      </template>
    </Modal>
  </div>
</template>
```

- [ ] **Step 6: Create `apps/dashboard/src/components/sharing/ConnectionsSection.vue`**

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'

type Connection = { user: string; share: string; client: string; connectedAt: string }

const connections = ref<Connection[]>([])
const loading = ref(true)
const error   = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    const res = await trpc.sharing.status.query()
    connections.value = res.connections
    error.value = ''
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load connections'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  poll()
  timer = setInterval(poll, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div>
    <div class="mb-6">
      <p class="eyebrow mb-1">Network sharing</p>
      <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Active connections</h2>
    </div>

    <p v-if="error" class="status-text text-[var(--c-danger)] mb-4">[ERR] {{ error }}</p>

    <div v-if="loading" class="text-sm text-[var(--c-text-3)]">Loading…</div>

    <div v-else-if="connections.length === 0" class="panel-card bg-[var(--c-surface)] p-6 text-sm text-[var(--c-text-3)]">
      No active SMB connections.
    </div>

    <div v-else class="panel-card bg-[var(--c-surface)]">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-[var(--c-border)]">
            <th class="eyebrow text-left px-4 py-3">User</th>
            <th class="eyebrow text-left px-4 py-3">Share</th>
            <th class="eyebrow text-left px-4 py-3">Client</th>
            <th class="eyebrow text-left px-4 py-3">Connected</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(c, i) in connections"
            :key="i"
            class="border-b border-[var(--c-border)] last:border-b-0"
          >
            <td class="px-4 py-2.5 text-[var(--c-text-1)]">{{ c.user || 'guest' }}</td>
            <td class="px-4 py-2.5 text-[var(--c-text-2)]">{{ c.share }}</td>
            <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-2)]">{{ c.client }}</td>
            <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-3)]">{{ c.connectedAt }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
```

- [ ] **Step 7: Changelog entry**

In `CHANGELOG.md`, under the `## [Unreleased]` heading, add (create the `### Added` subsection if absent):

```markdown
### Added

- SMB network sharing: share any place over the network via Samba, managed from the new admin-only Sharing desktop app (share list with per-place permissions mapping, live connections view, guest access and read-only options). Passwords are kept in sync NAS-style across web, Linux, and Samba accounts. Requires `samba` to be installed on the host; the app detects it and shows the install command otherwise.
```

- [ ] **Step 8: Type-check and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: exit 0, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/lib/desktop.ts apps/dashboard/src/components/desktop/Launchpad.vue apps/dashboard/src/components/desktop/DesktopWindow.vue apps/dashboard/src/components/sharing/ CHANGELOG.md
git commit -m "feat(sharing): add Sharing desktop app (shares management + live connections)"
```

---

## Verification (manual pass, on a host with Samba installable)

1. **Prereq state**: without `samba` installed, open Sharing → Shares shows the "Samba is not installed" card with `sudo apt install samba`, no creation form. Install samba, click "Check again" → the share list appears.
2. **Create a share**: New share → pick a Place → Create. On the host: `/etc/systemd/system/smbd.service.d/nasui.conf` exists, `/etc/nasui/samba/smb.conf` contains the share, `/etc/samba/smb.conf` is untouched (`dpkg -V samba` reports no conffile change), `systemctl status smbd` is active.
3. **Password sync**: log out/in with a user that has a `linuxUsername` and `canRead` on the shared Place, then from another machine: `smbclient //HOST/SHARE -U user` with the web password → connects. Write a file: succeeds only if the user has `canWrite` and the share is not read-only.
4. **Permission reflection**: revoke the user's `canRead` in Permissions → reconnect → access denied.
5. **Excluded-user warning**: give a Place permission to a user without `linuxUsername` → the share card shows the `[WARN] No Linux account for …` line.
6. **Guest**: enable guest on a share → `smbclient -N //HOST/SHARE` connects.
7. **Connections**: while a client is connected, the Connections section lists user, share, client IP; disconnecting removes it within ~5s.
8. **Disable/delete**: disable the share → it disappears from `smbclient -L`; delete it → same, and the row is gone from the UI.
