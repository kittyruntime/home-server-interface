import { ref, type Ref } from 'vue'
import { trpc } from '../../lib/trpc'

export type SmartAttr = {
  id: number; name: string; value: number; worst: number; thresh: number
  raw: number; failed: boolean; isCritical: boolean
}
export type NvmeInfo = {
  criticalWarning: number; temperature: number
  availableSpare: number; availableSpareThresh: number; percentageUsed: number
  dataReadTiB: number; dataWrittenTiB: number; mediaErrors: number; errorLogEntries: number
}
export type SmartResult = {
  device: string; available: boolean
  modelFamily?: string; modelName?: string; serialNumber?: string; firmware?: string
  rotationRate: number; healthPassed: boolean; temperature: number
  /** passed | failed | unknown (no overall status, e.g. virtio or USB bridges) */
  health?: SmartHealth; warnings?: string[]
  /** No SMART at all (virtio, USB bridge), as opposed to a disk skipped in standby. */
  unsupported?: boolean
  powerOnHours: number; powerCycles: number
  attributes: SmartAttr[]; nvme?: NvmeInfo
  _loading?: boolean; _error?: string
}

export type SmartStatus = 'unknown' | 'loading' | 'passed' | 'warning' | 'failed'
export type SmartHealth = 'passed' | 'failed' | 'unknown'

/** Overall health; older workers only sent healthPassed. */
export function smartHealth(s: SmartResult): SmartHealth {
  return s.health ?? (s.healthPassed ? 'passed' : 'failed')
}

/** A zero-value SmartResult with optional overrides (loading/error markers). */
export function emptySmart(device: string, extra: Partial<SmartResult> = {}): SmartResult {
  return {
    device, available: false, rotationRate: 0, healthPassed: false, temperature: 0,
    powerOnHours: 0, powerCycles: 0, attributes: [], ...extra,
  }
}

/** Derive a coarse health status from a SmartResult (or absence of one). */
export function smartStatus(s: SmartResult | undefined): SmartStatus {
  if (!s) return 'unknown'
  if (s._loading) return 'loading'
  if (!s.available) return 'unknown'
  const health = smartHealth(s)
  if (health === 'failed') return 'failed'
  if (s.warnings?.length) return 'warning'
  if (s.attributes.some(a => a.isCritical && a.raw > 0)) return 'warning'
  if (s.nvme && (s.nvme.criticalWarning > 0 || s.nvme.mediaErrors > 0)) return 'warning'
  return health === 'passed' ? 'passed' : 'unknown'
}

/** Query SMART for one bare device name (sda, nvme0n1) and write it into `cache`,
 *  marking loading first and never throwing (records `_error` instead).
 *  `noWake` skips a disk in standby instead of spinning it up. */
export async function fetchSmartInto(
  cache: Ref<Record<string, SmartResult>>,
  device: string,
  opts: { noWake?: boolean } = {},
): Promise<void> {
  cache.value = { ...cache.value, [device]: emptySmart(device, { _loading: true }) }
  try {
    const res = await trpc.storage.smartInfo.query({ device, noWake: opts.noWake }) as SmartResult
    cache.value = { ...cache.value, [device]: res }
  } catch (e: unknown) {
    cache.value = {
      ...cache.value,
      [device]: emptySmart(device, { _error: (e as { message?: string })?.message ?? 'SMART query failed' }),
    }
  }
}

/** SMART results shared by the Disks and Volumes lists, so each disk is read
 *  once while the user moves between them. */
export const sharedSmart = ref<Record<string, SmartResult>>({})

/** Standby-safe reads for a list of disks, at most `concurrency` at a time,
 *  skipping disks already read; stops when `cancelled()` turns true. */
export async function readSmartList(names: string[], cancelled: () => boolean, concurrency = 3): Promise<void> {
  const queue = names.filter(n => !sharedSmart.value[n] || sharedSmart.value[n]!._error)
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let n = queue.shift(); n && !cancelled(); n = queue.shift()) await fetchSmartInto(sharedSmart, n, { noWake: true })
  })
  await Promise.all(workers)
}
