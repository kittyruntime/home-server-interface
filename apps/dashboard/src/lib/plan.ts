import { ref } from 'vue'
import { trpc } from './trpc'

// Operation plans (#36): a storage, app, share or user account operation is first previewed as the
// exact steps HSI will take, then applied as that plan. `applyPlanned` opens the
// single <PlanDialog/> mounted in the dashboard shell and settles once the
// plan ran, failed, or was cancelled.

export type StorageOp = Parameters<typeof trpc.storage.plan.mutate>[0]['op']
export type AppOp = Parameters<typeof trpc.apps.plan.mutate>[0]['op']
export type ShareOp = Parameters<typeof trpc.sharing.plan.mutate>[0]['op']
export type UserOp = Parameters<typeof trpc.user.plan.mutate>[0]['op']
export type PlanOp = StorageOp | AppOp | ShareOp | UserOp | 'volume.create' | 'volume.remove'
export type PlanDomain = 'storage' | 'apps' | 'sharing' | 'users' | 'volume'

type StorageStep = Awaited<ReturnType<typeof trpc.storage.plan.mutate>>['steps'][number]
type AppStep = Awaited<ReturnType<typeof trpc.apps.plan.mutate>>['steps'][number]
export type PlanStep = StorageStep & Partial<AppStep>
export interface PlanPreview { steps: PlanStep[]; fingerprint: string }
export interface PlanApply {
  ok: boolean
  error?: string
  steps: PlanStep[]
  results: Array<{ status: string; error?: string; detail?: string; jobId?: string }>
  warnings?: string[]
  reply?: Record<string, unknown>
}

export interface PlanRequest {
  id: number
  domain: PlanDomain
  op: PlanOp
  input: Record<string, unknown>
  title: string
  /** Label of the action button, e.g. "Format /dev/sdb1". */
  actionLabel: string
  /** Danger styling even without an erasing step (e.g. giving up redundancy). */
  danger?: boolean
  /** The action stays disabled until this text is typed (a name to erase). */
  confirmText?: string
  /** A line the review opens with, e.g. what data is lost. */
  notice?: string
  resolve: (r: PlanOutcome) => void
}

export type PlanOutcome =
  | { status: 'applied'; result: PlanApply }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }

export const planRequest = ref<PlanRequest | null>(null)
let nextId = 0

/**
 * Previews then applies an operation (storage by default). Resolves with the
 * reply fields (`jobId` for an app operation that started a background job)
 * and warnings when it ran; throws with the failure message when a step
 * failed; throws with an empty message when the user cancelled (callers that
 * show `e.message` then show nothing).
 */
export async function applyPlanned(
  op: PlanOp,
  input: Record<string, unknown>,
  opts: { title: string; actionLabel: string; danger?: boolean; domain?: PlanDomain; confirmText?: string; notice?: string },
): Promise<{ warnings: string[] } & Record<string, unknown>> {
  const outcome = await new Promise<PlanOutcome>(resolve => {
    planRequest.value?.resolve({ status: 'cancelled' })
    planRequest.value = { id: nextId++, op, input, ...opts, domain: opts.domain ?? 'storage', resolve }
  })
  if (outcome.status === 'applied') {
    return { ...(outcome.result.reply ?? {}), warnings: outcome.result.warnings ?? [] }
  }
  throw new Error(outcome.status === 'failed' ? outcome.error : '')
}

/**
 * Previews then applies an app operation that starts a background job
 * (apply, start, remove) and returns that job's id, to follow as before.
 */
export async function applyPlannedJob(
  op: AppOp,
  input: Record<string, unknown>,
  opts: { title: string; actionLabel: string; danger?: boolean },
): Promise<string> {
  const reply = await applyPlanned(op, input, { ...opts, domain: 'apps' })
  if (typeof reply.jobId !== 'string') throw new Error('The operation did not start a job')
  return reply.jobId
}
