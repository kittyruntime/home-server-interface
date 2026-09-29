import crypto from "node:crypto"

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

/** Masks environment values whose key looks like a secret, in map and list syntax. */
export function maskSecrets(yaml: string): string {
  return yaml.split("\n").map(line => {
    const list = line.match(/^(\s*-\s*["']?)([A-Za-z0-9_.-]+)=(.*?)(["']?\s*)$/)
    if (list && SECRET_KEY.test(list[2]!)) return `${list[1]}${list[2]}=${MASK}${list[4]}`
    const map = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s+(\S.*)$/)
    if (map && SECRET_KEY.test(map[2]!) && !/^[|>]/.test(map[3]!)) return `${map[1]}${map[2]}: ${MASK}`
    return line
  }).join("\n")
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
