import path from "node:path"
import { TRPCError } from "@trpc/server"
import { z } from "zod"
import type { ApiScope } from "../services/api-tokens"
import { MAX_DELETE_PATHS, MAX_OVERWRITE_CHARS, fileSignature } from "../services/agent-actions"
import type { Caller, ToolContext, ToolDef } from "./tools"

// The tools that change something (#138). Reversible changes run at once,
// with the user's rights: making a folder or a new file, renaming, moving and
// copying (none overwrite), starting or stopping an app, running a backup.
// Everything else is queued for the user's approval in the dashboard:
// deletions, overwrites, and every storage, app, account, share, access and
// update change, which the assistant first previews as a plan.

const tool = <S extends z.ZodRawShape>(def: ToolDef<S>) => def as unknown as ToolDef

// How long a tool waits for a file job before telling the assistant to check
// back with the job id.
const JOB_WAIT_MS = 60_000

async function waitJob(caller: Caller, jobId: string) {
  const deadline = Date.now() + JOB_WAIT_MS
  for (;;) {
    const job = await caller.tasks.get({ jobId })
    if (job.status === "completed") return { done: true, result: job.result }
    if (job.status === "failed") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: job.error ?? "The operation failed" })
    if (Date.now() > deadline) return { done: false, jobId, status: job.status }
    await new Promise(r => setTimeout(r, 300))
  }
}

async function exists(caller: Caller, path: string): Promise<boolean> {
  try {
    await caller.fs.stat({ path })
    return true
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") return false
    throw e
  }
}

const reason = z.string().max(500).optional().describe("Why, in a sentence: shown to the user who approves")

// ── Plans: preview, then ask ─────────────────────────────────────────────────

type PlanKind = "storage" | "apps" | "user" | "sharing"

interface PlanFamily {
  kind: PlanKind
  /** Every scope an op of this family can need. */
  scopes: ApiScope[]
  scope: (op: string) => ApiScope
  requires: ToolDef["requires"]
  ops: string
  plan: (caller: Caller, op: string, input: unknown) => Promise<{ steps: Array<{ destructive?: boolean; summary?: string }>; fingerprint: string }>
}

// Network, HTTPS, server name and backup settings go through the storage
// router's plans, but belong to the system scope.
const SYSTEM_PLAN_OPS = /^(network\.|tls\.|system\.identity$|backup\.)/

const FAMILIES: Record<string, PlanFamily> = {
  storage: {
    kind: "storage", requires: "storage", scopes: ["storage:write", "system:write"],
    scope: op => SYSTEM_PLAN_OPS.test(op) ? "system:write" : "storage:write",
    ops: "format, part.init, part.create, part.delete, pv.create, vg.create, lv.create, lv.remove, vg.remove, mount, umount, raid.create, raid.stop, raid.fail, raid.remove, raid.add, import.assemble, import.activate, volume.expand, storage.reapply, storage.accept, system.identity, network.ipv4, tls.*, backup.plan.save, backup.plan.remove, backup.repository.save, backup.repository.remove, backup.restore",
    plan: (c, op, input) => c.storage.plan({ op: op as never, input }),
  },
  app: {
    kind: "apps", requires: "admin", scopes: ["apps:write"], scope: () => "apps:write",
    ops: "app.install, app.save, app.apply, app.start, app.remove, app.update, app.rollback",
    plan: (c, op, input) => c.apps.plan({ op: op as never, input }),
  },
  account: {
    kind: "user", requires: "userManager", scopes: ["users:write"], scope: () => "users:write",
    ops: "user.create, user.delete",
    plan: (c, op, input) => c.user.plan({ op: op as never, input }),
  },
  share: {
    kind: "sharing", requires: "admin", scopes: ["users:write"], scope: () => "users:write",
    ops: "share.create, share.update, share.remove",
    plan: (c, op, input) => c.sharing.plan({ op: op as never, input }),
  },
}

function needScope(ctx: ToolContext, scope: ApiScope) {
  if (!ctx.user.apiToken.scopes.includes(scope)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `This access token does not allow ${scope}` })
  }
}

function planTools(family: string, f: PlanFamily): ToolDef[] {
  const a = /^[aeiou]/.test(family) ? "an" : "a"
  const opDesc = `The operation: ${f.ops}`
  const inputDesc = "The operation's input, as the dashboard sends it"
  // Offered with any of the family's scopes; each op's own is checked per call.
  const base = f.scopes[0]
  return [
    tool({
      name: `preview_${family}_change`, title: `Preview ${a} ${family} change`, scope: base, anyScope: f.scopes, requires: f.requires,
      input: { op: z.string().describe(opDesc), input: z.record(z.string(), z.unknown()).describe(inputDesc) },
      description: `Shows the plan of ${a} ${family} change: each step, and which ones destroy data. Nothing is changed. Show the plan to the user, then call request_${family}_change with its fingerprint.`,
      run: async ({ op, input }, ctx) => {
        needScope(ctx, f.scope(op))
        return f.plan(ctx.caller, op, input)
      },
    }),
    tool({
      name: `request_${family}_change`, title: `Ask to apply ${a} ${family} change`, scope: base, anyScope: f.scopes, requires: f.requires,
      input: {
        op: z.string().describe(opDesc), input: z.record(z.string(), z.unknown()).describe(inputDesc),
        fingerprint: z.string().min(1).describe(`The fingerprint from preview_${family}_change`), reason,
      },
      description: `Asks the user to approve exactly the plan previewed: it waits in HSI until they approve or reject it there. If the server changed since the preview, plan again. Follow up with check_request.`,
      run: async ({ op, input, fingerprint, reason }, ctx) => {
        needScope(ctx, f.scope(op))
        const plan = await f.plan(ctx.caller, op, input)
        if (plan.fingerprint !== fingerprint) {
          throw new TRPCError({ code: "CONFLICT", message: "The server changed since this preview: preview it again", cause: { code: "ESTALE" } })
        }
        return ctx.queue({
          procedure: `${f.kind}.execute`, input: { op, input, fingerprint },
          title: `${op} ${String((input as Record<string, unknown>).name ?? (input as Record<string, unknown>).device ?? (input as Record<string, unknown>).mountPoint ?? "")}`.trim(),
          preview: { steps: plan.steps }, destructive: plan.steps.some(s => s.destructive), reason,
        })
      },
    }),
  ]
}

export const WRITE_TOOLS: ToolDef[] = [
  // ── Files ────────────────────────────────────────────────────────────────
  tool({
    name: "create_folder", title: "Create a folder", scope: "files:write",
    input: { parentPath: z.string().min(1), name: z.string().min(1).max(255) },
    description: "Makes a folder, owned by this account.",
    run: async (args, { caller }) => waitJob(caller, (await caller.fs.mkdir(args)).jobId),
  }),
  tool({
    name: "write_text_file", title: "Write a text file", scope: "files:write",
    input: {
      path: z.string().min(1), content: z.string().max(1_000_000),
      overwrite: z.boolean().default(false).describe("Replace an existing file: this waits for the user's approval"),
      reason,
    },
    description: "Writes a new text file. Replacing an existing one waits for the user's approval.",
    run: async ({ path, content, overwrite, reason }, ctx) => {
      if (!await exists(ctx.caller, path)) return waitJob(ctx.caller, (await ctx.caller.fs.writeText({ path, content })).jobId)
      if (!overwrite) throw new TRPCError({ code: "CONFLICT", message: "The file exists: set overwrite to ask the user to replace it" })
      if (content.length > MAX_OVERWRITE_CHARS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Replacing a file is limited to ${MAX_OVERWRITE_CHARS} characters, so the user can read all of it: write a new file instead` })
      }
      const current = await ctx.caller.fs.stat({ path })
      return ctx.queue({
        procedure: "fs.writeText", input: { path, content, sig: fileSignature(current) }, title: `Replace ${path}`,
        preview: { replace: path, currentSize: current.size, content }, destructive: true, reason,
      })
    },
  }),
  tool({
    name: "rename", title: "Rename", scope: "files:write",
    input: { path: z.string().min(1), newName: z.string().min(1).max(255) },
    description: "Renames a file or folder; refused when the new name exists.",
    run: async (args, { caller }) => waitJob(caller, (await caller.fs.rename(args)).jobId),
  }),
  tool({
    name: "move", title: "Move", scope: "files:write",
    input: { src: z.string().min(1), dstDir: z.string().min(1).describe("The folder to move it into") },
    description: "Moves a file or folder into another folder; refused when the destination has the same name.",
    run: async (args, { caller }) => waitJob(caller, (await caller.fs.move(args)).jobId),
  }),
  tool({
    name: "copy", title: "Copy", scope: "files:write",
    input: { src: z.string().min(1), dstDir: z.string().min(1).describe("The folder to copy it into") },
    description: "Copies a file or folder into another folder; refused when the destination has the same name.",
    run: async (args, { caller }) => waitJob(caller, (await caller.fs.copy(args)).jobId),
  }),
  tool({
    name: "delete_files", title: "Delete files", scope: "files:write",
    input: { paths: z.array(z.string().min(1)).min(1).max(MAX_DELETE_PATHS), reason },
    description: `Asks the user to approve deleting up to ${MAX_DELETE_PATHS} files or folders (with everything in them). Deletion is permanent. Follow up with check_request.`,
    run: async ({ paths, reason }, ctx) => {
      const items = []
      for (const path of paths) items.push({ path, ...(await ctx.caller.fs.stat({ path })) })
      // Approved as they are now: each path's state is checked again first.
      const expect = items.map(i => ({ path: i.path, sig: fileSignature(i) }))
      return ctx.queue({
        procedure: "fs.delete", input: { paths, expect }, title: paths.length === 1 ? `Delete ${paths[0]}` : `Delete ${paths.length} items`,
        preview: { delete: items.map(i => ({ path: i.path, type: i.type, size: i.size, mtime: i.mtime })) }, destructive: true, reason,
      })
    },
  }),

  // ── Apps ─────────────────────────────────────────────────────────────────
  ...(["start", "stop", "restart"] as const).map(action => tool({
    name: `${action}_app`, title: `${action[0].toUpperCase()}${action.slice(1)} an app`, scope: "apps:write", requires: "admin",
    input: { name: z.string().describe("The app name from list_apps") },
    description: `${action[0].toUpperCase()}${action.slice(1)}s an app's containers.`,
    run: (args, { caller }) => caller.container.app[action](args),
  })),

  // ── Plans ────────────────────────────────────────────────────────────────
  ...Object.entries(FAMILIES).flatMap(([family, f]) => planTools(family, f)),

  // ── Places ───────────────────────────────────────────────────────────────
  tool({
    name: "request_create_place", title: "Ask to create a Place", scope: "users:write", requires: "admin",
    input: {
      name: z.string().trim().min(1).max(100).describe("The Place's name, as people see it"),
      path: z.string().regex(/^\/[^\0]*$/).describe("Absolute path of its folder, e.g. /srv/data/Photos"),
      createFolder: z.boolean().default(false).describe("Make the folder too: it does not exist yet"),
      reason,
    },
    description: "Asks the user to approve a new Place (a shared folder people can be given access to). Its folder joins the share group. Nobody but admins can open it until access is given (request_place_access). Follow up with check_request.",
    run: async ({ reason, name, path: raw, createFolder }, ctx) => {
      const p = path.posix.normalize(raw)
      if (p !== raw.replace(/\/+$/, "") || p === "/") throw new TRPCError({ code: "BAD_REQUEST", message: "Give a plain absolute path, without .. or a trailing slash" })
      const places = await ctx.caller.place.list()
      const clash = places.find(pl => pl.path === p || p.startsWith(pl.path + "/") || pl.path.startsWith(p + "/"))
      if (clash) throw new TRPCError({ code: "CONFLICT", message: `It would overlap the Place "${clash.name}" (${clash.path})` })
      return ctx.queue({
        procedure: "place.create", input: { name, path: p, createFolder }, title: `Create the Place "${name}" at ${p}`,
        preview: { place: { name, path: p, newFolder: createFolder } }, destructive: false, reason,
      })
    },
  }),
  tool({
    name: "request_rename_place", title: "Ask to rename a Place", scope: "users:write", requires: "admin",
    input: { placeId: z.string().describe("A Place id from list_places"), name: z.string().trim().min(1).max(100), reason },
    description: "Asks the user to approve a new name for a Place. Its folder, access and share stay as they are. Follow up with check_request.",
    run: async ({ reason, placeId, name }, ctx) => {
      const place = (await ctx.caller.place.list()).find(pl => pl.id === placeId)
      if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown Place" })
      return ctx.queue({
        procedure: "place.rename", input: { id: placeId, name }, title: `Rename the Place "${place.name}" to "${name}"`,
        preview: { place: { path: place.path, from: place.name, to: name } }, destructive: false, reason,
      })
    },
  }),
  tool({
    name: "request_remove_place", title: "Ask to remove a Place", scope: "users:write", requires: "admin",
    input: { placeId: z.string().describe("A Place id from list_places"), reason },
    description: "Asks the user to approve removing a Place: its access rights and SMB share go, its folder and files stay on disk. Follow up with check_request.",
    run: async ({ reason, placeId }, ctx) => {
      const place = (await ctx.caller.place.list()).find(pl => pl.id === placeId)
      if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown Place" })
      return ctx.queue({
        procedure: "place.delete", input: { id: placeId }, title: `Remove the Place "${place.name}"`,
        preview: { place: { name: place.name, path: place.path, removed: "the Place, its access rights and its SMB share", kept: "the folder and its files" } },
        destructive: true, reason,
      })
    },
  }),

  // ── Access ───────────────────────────────────────────────────────────────
  tool({
    name: "request_place_access", title: "Ask to change who can access a Place", scope: "users:write", requires: "admin",
    input: {
      placeId: z.string(), subjectType: z.enum(["user", "group"]), subjectId: z.string(),
      canRead: z.boolean(), canWrite: z.boolean(), canDelete: z.boolean(), canShare: z.boolean(), reason,
    },
    description: "Asks the user to approve giving (or changing) a user's or group's rights on a Place. Follow up with check_request.",
    run: async ({ reason, ...input }, ctx) => ctx.queue({
      procedure: "permission.upsert", input, title: `Access to a Place for ${input.subjectType} ${input.subjectId}`,
      preview: { access: input }, destructive: false, reason,
    }),
  }),

  // ── System ───────────────────────────────────────────────────────────────
  tool({
    name: "run_backup", title: "Run a backup now", scope: "system:write", requires: "admin",
    input: { id: z.string().describe("A backup plan id from backup_status") },
    description: "Starts a backup plan now.",
    run: (args, { caller }) => caller.backup.runNow(args),
  }),
  tool({
    name: "request_update", title: "Ask to install an HSI update", scope: "system:write", requires: "admin",
    input: { version: z.string().regex(/^v\d+\.\d+\.\d+$/), reason },
    description: "Asks the user to approve updating HSI to a version from update_status. HSI restarts during the update.",
    run: async ({ version, reason }, ctx) => ctx.queue({
      procedure: "update.execute", input: { version }, title: `Update HSI to ${version}`,
      preview: { update: version }, destructive: false, reason,
    }),
  }),
]

/** Offered to any token: the follow-up of queued requests. */
export const CHECK_TOOL: ToolDef = tool({
  name: "check_request", title: "Check a request", scope: null,
  input: { id: z.string().describe("The request id a request_* or delete_files tool returned") },
  description: "Whether the user approved a request, and its result once it ran.",
  run: async ({ id }, ctx) => ctx.checkRequest(id),
})
