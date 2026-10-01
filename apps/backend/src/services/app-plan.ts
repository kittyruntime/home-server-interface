import crypto from "node:crypto"
import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { composeImages, generateComposeYaml, parseComposeYaml, zAppInput, type AppInput } from "@app/compose"
import type { AppManifest } from "@app/app-catalog"

// Operation plans for container apps (#36): what saving, applying, installing
// or removing an app will do (compose.yaml content or diff, Places, compose
// commands), shown before it runs and applied exactly as shown. Same step shape
// as the storage plans built by the worker.

export type AppOp = "app.save" | "app.apply" | "app.start" | "app.install" | "app.remove"
export const APP_OPS: AppOp[] = ["app.save", "app.apply", "app.start", "app.install", "app.remove"]

export interface AppStep {
  kind: string
  target: string
  summary: string
  command?: string[]
  diff?: string
  destructive?: boolean
  onFailure?: string
  /** Starts a worker job and returns at once; the job is followed elsewhere. */
  background?: boolean
  run?: () => Promise<{ detail?: string; jobId?: string }>
}

export interface AppPlan {
  op: AppOp
  steps: AppStep[]
  observed: Record<string, string>
  reply?: Record<string, unknown>
}

export interface AppStepResult { status: string; error?: string; detail?: string; jobId?: string }

// Same rule as the audit log redaction (trpc/index.ts).
const SECRET_KEY = /pass(word|wd)?|secret|token|key|auth|credential/i
const MASK = "••••••"

interface MaskedLine { shown: string; id?: string; raw?: string }

// A secret value may span several lines (a folded long value, a `|` block):
// the lines indented under its key belong to it and are hidden with it.
function maskLines(yaml: string, extraKeys: readonly string[] = []): MaskedLine[] {
  const isSecret = (k: string) => SECRET_KEY.test(k) || extraKeys.includes(k)
  const seen = new Map<string, number>()
  const idOf = (k: string) => { const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return `${k}#${n}` }
  const out: MaskedLine[] = []
  let open: { indent: number; line: MaskedLine } | null = null
  for (const line of yaml.split("\n")) {
    const indent = line.length - line.trimStart().length
    if (open && (line.trim() === "" || indent > open.indent)) { open.line.raw += "\n" + line; continue }
    open = null
    const list = line.match(/^(\s*-\s*["']?)([A-Za-z0-9_.-]+)=(.*?)(["']?\s*)$/)
    if (list && isSecret(list[2]!)) {
      out.push({ shown: `${list[1]}${list[2]}=${MASK}${list[4]}`, id: idOf(list[2]!), raw: list[3] })
      continue
    }
    // Only a key with a value on its line: a bare `secrets:` opens a nested mapping.
    const map = line.match(/^(\s*)(["']?)([A-Za-z0-9_.-]+)\2:\s+(\S.*)$/)
    if (map && isSecret(map[3]!)) {
      const ml: MaskedLine = { shown: `${map[1]}${map[2]}${map[3]}${map[2]}: ${MASK}`, id: idOf(map[3]!), raw: map[4] }
      out.push(ml)
      open = { indent: map[1]!.length, line: ml }
      continue
    }
    // A secret passed as a flag or KEY=value inside a flow list, e.g.
    // command: ["--db-password=x"].
    out.push({ shown: line.replace(SECRET_ASSIGN, (_m, key: string) => `${key}=${MASK}`) })
  }
  return out
}
const SECRET_ASSIGN = /((?:--)?[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|secret|token|key|auth|credential)[A-Za-z0-9_.-]*)=[^\s,"'\]]+/gi

/** Masks environment values whose key looks like a secret (or is listed), in map and list syntax. */
export function maskSecrets(yaml: string, extraKeys: readonly string[] = []): string {
  return maskLines(yaml, extraKeys).map(l => l.shown).join("\n")
}

/** Diff of two versions with secrets masked; a secret whose value changed is marked as such. */
export function maskedDiff(path: string, before: string, after: string, extraKeys: readonly string[] = []): string {
  if (before === after) return ""
  const b = maskLines(before, extraKeys)
  const was = new Map(b.filter(l => l.id).map(l => [l.id!, l.raw]))
  const a = maskLines(after, extraKeys).map(l =>
    l.id && was.has(l.id) && was.get(l.id) !== l.raw ? `${l.shown} (changed)` : l.shown)
  return unifiedDiff(path, b.map(l => l.shown).join("\n"), a.join("\n"))
}

export function manifestSecretKeys(m: { env: Array<{ key: string; secret?: boolean }> }): string[] {
  return m.env.filter(e => e.secret).map(e => e.key)
}

function splitLines(s: string): string[] {
  const t = s.endsWith("\n") ? s.slice(0, -1) : s
  return t === "" ? [] : t.split("\n")
}

/** Unified diff with two lines of context (files are small: plain LCS). */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return ""
  const a = splitLines(before), b = splitLines(after)
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  type Op = { kind: " " | "-" | "+"; text: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: " ", text: a[i]!, ai: i + 1, bi: j + 1 }); i++; j++ }
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: "-", text: a[i]!, ai: i + 1, bi: j }); i++ }
    else { ops.push({ kind: "+", text: b[j]!, ai: i, bi: j + 1 }); j++ }
  }
  const ctx = 2
  const name = path.replace(/^\//, "")
  let out = `--- a/${name}\n+++ b/${name}\n`
  for (let k = 0; k < ops.length;) {
    if (ops[k]!.kind === " ") { k++; continue }
    const start = Math.max(0, k - ctx)
    let end = k
    while (end < ops.length) {
      if (ops[end]!.kind !== " ") { end++; continue }
      let run = end
      while (run < ops.length && ops[run]!.kind === " ") run++
      if (run < ops.length && run - end <= 2 * ctx) { end = run; continue }
      end = Math.min(end + ctx, ops.length)
      break
    }
    const hunk = ops.slice(start, end)
    const aLines = hunk.filter(o => o.kind !== "+"), bLines = hunk.filter(o => o.kind !== "-")
    out += `@@ -${aLines[0]?.ai ?? 0},${aLines.length} +${bLines[0]?.bi ?? 0},${bLines.length} @@\n`
    for (const o of hunk) out += `${o.kind}${o.text}\n`
    k = end
  }
  return out
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
  }
  return v
}

export function publicSteps(plan: AppPlan): Omit<AppStep, "run">[] {
  return plan.steps.map(({ run: _run, ...s }) => s)
}

/** Fingerprint of what was previewed: steps as shown (secrets masked), input and observed state. */
export function appFingerprint(plan: AppPlan, input: unknown): string {
  const body = JSON.stringify(canonical({ op: plan.op, input, steps: publicSteps(plan), observed: plan.observed }))
  return crypto.createHash("sha256").update(body).digest("hex")
}

export async function executeAppPlan(plan: AppPlan): Promise<{ ok: boolean; error?: string; results: AppStepResult[] }> {
  const results: AppStepResult[] = plan.steps.map(() => ({ status: "not-run" }))
  for (const [i, s] of plan.steps.entries()) {
    try {
      const r = s.run ? await s.run() : {}
      results[i] = { status: s.background ? "started" : "done", ...r }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (s.onFailure === "warn") { results[i] = { status: "warning", error: message }; continue }
      results[i] = { status: "failed", error: message }
      return { ok: false, error: message, results }
    }
  }
  return { ok: true, results }
}

// ── Builders ─────────────────────────────────────────────────────────────────


export interface AppPlanDeps {
  stackPath(name: string): string
  readStack(name: string): Promise<string | null>
  findPlace(id: string): Promise<{ id: string; name: string; path: string } | null>
  placeAtPath(path: string): Promise<boolean>
  catalog(id: string): AppManifest | undefined
  secret(): string
  effects: {
    writeStack(name: string, yaml: string): Promise<void>
    removeStackDir(name: string): Promise<void>
    mkdirp(path: string): Promise<void>
    createPlace(name: string, path: string): Promise<string>
    validate(name: string): Promise<void>
    publishJob(action: string, payload: Record<string, unknown>): Promise<string>
  }
}

const zName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
const zInstallVolume = z.object({
  target: z.string().startsWith("/"),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("place"),    placeId: z.string() }),
    z.object({ kind: z.literal("newPlace"), name: z.string().min(1), path: z.string().startsWith("/") }),
    z.object({ kind: z.literal("bind"),     path: z.string().startsWith("/") }),
    z.object({ kind: z.literal("named"),    name: z.string().min(1) }),
  ]),
})

export const APP_INPUTS = {
  "app.save": z.object({ name: zName, create: z.boolean().default(false), data: zAppInput.optional(), raw: z.string().min(1).optional() })
    .refine(v => (v.data ? 1 : 0) + (v.raw ? 1 : 0) === 1, { message: "Give either the form data or the raw file" })
    .refine(v => !v.data || v.data.name === v.name, { message: "The app name in the form must be the app's name" }),
  "app.apply":  z.object({ name: zName }),
  "app.start":  z.object({ name: zName }),
  "app.remove": z.object({ name: zName }),
  "app.install": z.object({
    id:      z.string(),
    name:    zName.max(64),
    ports:   z.array(z.object({ container: z.number().int(), host: z.number().int().min(1).max(65535) })).default([]),
    env:     z.array(z.object({ key: z.string(), value: z.string() })).default([]),
    volumes: z.array(zInstallVolume).default([]),
  }),
} satisfies Record<AppOp, z.ZodTypeAny>

function bad(message: string): never { throw new TRPCError({ code: "BAD_REQUEST", message }) }

function parse<T extends AppOp>(op: T, input: unknown): z.infer<typeof APP_INPUTS[T]> {
  const r = APP_INPUTS[op].safeParse(input)
  if (!r.success) bad(r.error.issues[0]?.message ?? "Invalid input")
  return r.data as z.infer<typeof APP_INPUTS[T]>
}

async function existingStack(deps: AppPlanDeps, name: string): Promise<string> {
  const current = await deps.readStack(name)
  if (current === null) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" })
  return current
}

// Place volumes become bind mounts of the Place's path (as generateComposeYaml requires).
async function resolvePlaces(deps: AppPlanDeps, volumes: AppInput["volumes"]): Promise<AppInput["volumes"]> {
  return Promise.all(volumes.map(async v => {
    if (v.type !== "place") return v
    const place = await deps.findPlace(v.source)
    if (!place) throw new TRPCError({ code: "NOT_FOUND", message: `Place ${v.source} not found` })
    return { ...v, type: "bind" as const, source: place.path }
  }))
}

function fileStep(deps: AppPlanDeps, name: string, before: string | null, yaml: string, summary: string, extraRun?: () => Promise<void>, secretKeys: readonly string[] = []): AppStep {
  const target = deps.stackPath(name)
  return {
    kind: before === null ? "create" : "update",
    target,
    summary,
    diff: before === null
      ? unifiedDiff(target, "", maskSecrets(yaml, secretKeys))
      : maskedDiff(target, before, yaml, secretKeys),
    run: async () => {
      await deps.effects.writeStack(name, yaml)
      if (extraRun) await extraRun()
      return {}
    },
  }
}

function upStep(deps: AppPlanDeps, name: string, content: string, validate: boolean): AppStep {
  // A file broken by hand is the admin's to fix: say so plainly.
  let parsed: ReturnType<typeof parseComposeYaml>
  let images: string[]
  try {
    parsed = parseComposeYaml(content)
    images = composeImages(content)
  } catch {
    bad("The compose file is not valid YAML; fix it in the compose editor")
  }
  const what = parsed.services.length ? `services ${parsed.services.join(", ")}` : "its services"
  return {
    kind: "run",
    target: name,
    summary: `Start ${name} (${what}${images.length ? `, ${images.length === 1 ? "image" : "images"} ${images.join(", ")}` : ""}); images are pulled if missing`,
    command: ["docker", "compose", "-f", deps.stackPath(name), "up", "-d"],
    background: true,
    run: async () => {
      if (validate) await deps.effects.validate(name)
      return { jobId: await deps.effects.publishJob("container.composeUp", { name }) }
    },
  }
}

export async function buildAppPlan(op: AppOp, input: unknown, deps: AppPlanDeps): Promise<AppPlan> {
  switch (op) {
    case "app.save": {
      const req = parse("app.save", input)
      const before = await deps.readStack(req.name)
      if (req.create && before !== null) throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })
      if (!req.create && before === null) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" })
      let yaml: string
      if (req.raw) {
        let services: string[]
        try { services = parseComposeYaml(req.raw).services } catch { bad("The file is not valid YAML") }
        if (services.length === 0) bad("The file must declare at least one service")
        yaml = req.raw
      } else {
        const data = req.data!
        yaml = generateComposeYaml({ ...data, volumes: await resolvePlaces(deps, data.volumes) } as AppInput, before ?? undefined)
      }
      const step = fileStep(deps, req.name, before, yaml,
        before === null ? `Create the compose file of ${req.name}`
          : before === yaml ? `No change to the compose file of ${req.name}; it is written as it is`
          : `Update the compose file of ${req.name}; the running containers change only when you apply`)
      return { op, steps: [step], observed: { content: before ?? "" }, reply: { name: req.name } }
    }
    case "app.apply":
    case "app.start": {
      const req = parse(op, input)
      const content = await existingStack(deps, req.name)
      return { op, steps: [upStep(deps, req.name, content, op === "app.apply")], observed: { content } }
    }
    case "app.remove": {
      const req = parse("app.remove", input)
      const content = await existingStack(deps, req.name)
      const path = deps.stackPath(req.name)
      const dir = path.replace(/\/compose\.yaml$/, "/")
      return {
        op,
        observed: { content },
        steps: [
          {
            kind: "run", target: req.name, background: true,
            summary: `Stop and remove the containers of ${req.name}`,
            command: ["docker", "compose", "-f", path, "down"],
            run: async () => ({ jobId: await deps.effects.publishJob("container.composeDown", { name: req.name, removeFiles: true }) }),
          },
          {
            kind: "delete", target: dir, destructive: true, background: true,
            summary: `Delete ${dir} (its compose file); named volumes and data folders outside it are kept`,
            run: async () => ({ detail: "done by the same job as the previous step" }),
          },
        ],
      }
    }
    case "app.install":
      return buildInstallPlan(parse("app.install", input), deps)
  }
}

async function buildInstallPlan(input: z.infer<typeof APP_INPUTS["app.install"]>, deps: AppPlanDeps): Promise<AppPlan> {
  const m = deps.catalog(input.id)
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown app" })
  if (await deps.readStack(input.name) !== null) throw new TRPCError({ code: "CONFLICT", message: "An app with this name already exists" })

  const manifestTargets = new Set(m.volumes.map(v => v.target))
  for (const v of input.volumes) if (!manifestTargets.has(v.target)) bad(`Unexpected volume ${v.target}`)
  const manifestPorts = new Set(m.ports.map(p => p.container))
  for (const p of input.ports) if (!manifestPorts.has(p.container)) bad(`Unexpected port ${p.container}`)

  const newPlaces = input.volumes.flatMap(v => (v.source.kind === "newPlace" ? [v.source] : []))
  if (new Set(newPlaces.map(p => p.path)).size !== newPlaces.length) bad("Two volumes cannot create a new Place at the same path")
  for (const p of newPlaces) {
    if (await deps.placeAtPath(p.path)) throw new TRPCError({ code: "CONFLICT", message: `A Place already exists at ${p.path}` })
  }

  const submitted = new Map(input.volumes.map(v => [v.target, v.source]))
  const volumes: AppInput["volumes"] = await Promise.all(m.volumes.map(async mv => {
    const s = submitted.get(mv.target)
    const readOnly = mv.readOnlyDefault
    if (!s) bad(`Missing volume ${mv.target}`)
    if (s.kind === "place") {
      const place = await deps.findPlace(s.placeId)
      if (!place) throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" })
      return { type: "bind" as const, source: place.path, target: mv.target, readOnly }
    }
    if (s.kind === "newPlace") return { type: "bind" as const, source: s.path, target: mv.target, readOnly }
    if (s.kind === "bind") return { type: "bind" as const, source: s.path, target: mv.target, readOnly }
    return { type: "named" as const, source: s.name, target: mv.target, readOnly }
  }))

  const submittedEnv = new Map(input.env.map(e => [e.key, e.value]))
  const envs = m.env.map(me => {
    let value = submittedEnv.get(me.key) ?? me.default ?? ""
    if (!value && me.secret) value = deps.secret()
    if (!value && me.required) bad(`Missing required setting ${me.key}`)
    return { key: me.key, value }
  })
  const submittedPorts = new Map(input.ports.map(p => [p.container, p.host]))
  const ports = m.ports.map(mp => ({
    containerPort: mp.container,
    hostPort:      submittedPorts.get(mp.container) ?? mp.hostDefault ?? mp.container,
    protocol:      mp.protocol as "tcp" | "udp",
    tls:           false,
  }))
  const webPort = m.webUiPort != null ? ports.find(p => p.containerPort === m.webUiPort)?.hostPort ?? m.webUiPort : undefined

  const yaml = generateComposeYaml({
    name: input.name, image: m.image, ports, envs, volumes, networkNames: [],
    labels: [{ key: "hsi.catalog.id", value: m.id }], capAdd: [], capDrop: [], extraHosts: [],
    restartPolicy: m.restartPolicy, hostname: null, user: null, command: null, cpuLimit: null, memoryLimit: null,
  } as AppInput)

  const steps: AppStep[] = []
  for (const p of newPlaces) {
    steps.push({ kind: "create", target: p.path, summary: `Create the folder ${p.path}`, run: async () => { await deps.effects.mkdirp(p.path); return {} } })
    steps.push({ kind: "create", target: `Place "${p.name}"`, summary: `Create the Place "${p.name}" on ${p.path}`, run: async () => { await deps.effects.createPlace(p.name, p.path); return {} } })
  }
  // Written then validated with docker compose; an invalid file is removed
  // again (the Places created above stay, as before).
  steps.push(fileStep(deps, input.name, null, yaml, `Create the compose file of ${input.name} (${m.name}, ${m.image})`, async () => {
    try {
      await deps.effects.validate(input.name)
    } catch (e) {
      await deps.effects.removeStackDir(input.name).catch(() => {})
      throw e
    }
  }, manifestSecretKeys(m)))
  steps.push(upStep(deps, input.name, yaml, false))
  return { op: "app.install", steps, observed: {}, reply: { name: input.name, webPort } }
}

// Input of apps.plan/apply as recorded in the audit log: a raw compose file
// has its secrets masked like the preview.
export function appAuditInput(req: { op: string; input?: unknown; fingerprint?: string }): unknown {
  const input = req.input as Record<string, unknown> | null
  if (input && typeof input === "object" && typeof input.raw === "string") {
    return { ...req, input: { ...input, raw: maskSecrets(input.raw) } }
  }
  return req
}
