import { ref } from 'vue'
import { trpc } from './trpc'

// Operation plans (#36): a storage operation is first previewed as the exact
// steps HSI will take, then applied as that plan. `applyPlanned` opens the
// single <PlanDialog/> mounted in the dashboard shell and settles once the
// plan ran, failed, or was cancelled.

export type PlanOp = Parameters<typeof trpc.storage.plan.mutate>[0]['op']
export type PlanPreview = Awaited<ReturnType<typeof trpc.storage.plan.mutate>>
export type PlanStep = PlanPreview['steps'][number]
export type PlanApply = Awaited<ReturnType<typeof trpc.storage.apply.mutate>>

export interface PlanRequest {
  id: number
  op: PlanOp
  input: Record<string, unknown>
  title: string
  /** Label of the action button, e.g. "Format /dev/sdb1". */
  actionLabel: string
  /** Danger styling even without an erasing step (e.g. giving up redundancy). */
  danger?: boolean
  resolve: (r: PlanOutcome) => void
}

export type PlanOutcome =
  | { status: 'applied'; result: PlanApply }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }

export const planRequest = ref<PlanRequest | null>(null)
let nextId = 0

/**
 * Previews then applies a storage operation. Resolves with the worker's reply
 * fields and warnings when it ran; throws with the failure message when a step
 * failed; throws with an empty message when the user cancelled (callers that
 * show `e.message` then show nothing).
 */
export async function applyPlanned(
  op: PlanOp,
  input: Record<string, unknown>,
  opts: { title: string; actionLabel: string; danger?: boolean },
): Promise<{ warnings: string[] } & Record<string, unknown>> {
  const outcome = await new Promise<PlanOutcome>(resolve => {
    planRequest.value?.resolve({ status: 'cancelled' })
    planRequest.value = { id: nextId++, op, input, ...opts, resolve }
  })
  if (outcome.status === 'applied') {
    return { ...(outcome.result.reply ?? {}), warnings: outcome.result.warnings ?? [] }
  }
  throw new Error(outcome.status === 'failed' ? outcome.error : '')
}
