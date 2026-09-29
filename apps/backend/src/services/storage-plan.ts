// Operation plans for storage (#36): the operations that are previewed before
// they run, and the summary of an executed plan kept in the audit log.

export const PLAN_OPS = [
  "format", "part.init", "part.create", "part.delete",
  "pv.create", "vg.create", "lv.create", "lv.remove", "vg.remove",
  "mount", "umount", "raid.create", "raid.stop",
  "raid.fail", "raid.remove", "raid.add", "import.assemble", "import.activate",
] as const

export type PlanOp = typeof PLAN_OPS[number]

export interface DeviceInfo { path: string; model?: string; serial?: string; size?: number; contents?: string }

export interface PlanStep {
  kind: string
  target: string
  summary: string
  command?: string[]
  diff?: string
  destructive?: boolean
  deferred?: boolean
  device?: DeviceInfo
  devices?: DeviceInfo[]
  onFailure?: string
}

export interface StepResult { status: string; error?: string; detail?: string }

export type PlanApplyResult = { ok: boolean; error?: string; steps: PlanStep[]; results: StepResult[]; warnings?: string[]; reply?: Record<string, unknown> }

export function planAuditMeta(op: string, steps: PlanStep[], results: StepResult[]) {
  return {
    op,
    steps: steps.map((s, i) => ({
      kind: s.kind,
      target: s.target,
      summary: s.summary,
      ...(s.command ? { command: s.command.join(" ") } : {}),
      ...(s.diff ? { diff: s.diff } : {}),
      ...(s.destructive ? { destructive: true } : {}),
      status: results[i]?.status ?? "not-run",
      ...(results[i]?.error ? { error: results[i]!.error } : {}),
    })),
  }
}
