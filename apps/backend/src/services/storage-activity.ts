// Recent operations on one storage object (#40): audit rows whose target is
// the object, with the steps of the plan they ran when there was one.

export type ActivityRow = {
  id: string
  action: string
  target: string | null
  success: boolean
  createdAt: Date
  meta: string | null
  user: { username: string } | null
}

export type ActivityEntry = {
  id: string
  action: string
  target: string | null
  success: boolean
  at: string
  user: string | null
  /** The plan operation (format, mount, raid.add...) when the entry ran one. */
  op?: string
  steps?: Array<{ summary: string; status: string }>
}

function planOf(meta: string | null): Pick<ActivityEntry, "op" | "steps"> {
  if (!meta) return {}
  try {
    const plan = (JSON.parse(meta) as { plan?: { op?: unknown; steps?: Array<{ summary?: unknown; status?: unknown }> } }).plan
    if (!plan || !Array.isArray(plan.steps)) return {}
    return {
      ...(typeof plan.op === "string" ? { op: plan.op } : {}),
      steps: plan.steps.map(s => ({ summary: String(s.summary ?? ""), status: String(s.status ?? "") })),
    }
  } catch {
    return {}
  }
}

export function activityEntries(rows: ActivityRow[]): ActivityEntry[] {
  return rows.map(r => {
    return {
      id: r.id, action: r.action, target: r.target, success: r.success,
      at: r.createdAt.toISOString(), user: r.user?.username ?? null,
      ...planOf(r.meta),
    }
  })
}

// Previews (storage.plan) are audited like any mutation, with the same target
// as the apply that follows; they did not change anything.
export function activityWhere(targets: string[]) {
  return { target: { in: targets }, action: { notIn: ["storage.plan"] } }
}
