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
  steps?: Array<{ summary: string; status: string }>
}

function planSteps(meta: string | null): ActivityEntry["steps"] {
  if (!meta) return undefined
  try {
    const steps = (JSON.parse(meta) as { plan?: { steps?: Array<{ summary?: unknown; status?: unknown }> } }).plan?.steps
    if (!Array.isArray(steps)) return undefined
    return steps.map(s => ({ summary: String(s.summary ?? ""), status: String(s.status ?? "") }))
  } catch {
    return undefined
  }
}

export function activityEntries(rows: ActivityRow[]): ActivityEntry[] {
  return rows.map(r => {
    const steps = planSteps(r.meta)
    return {
      id: r.id, action: r.action, target: r.target, success: r.success,
      at: r.createdAt.toISOString(), user: r.user?.username ?? null,
      ...(steps ? { steps } : {}),
    }
  })
}
