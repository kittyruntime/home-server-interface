import { type Ref } from 'vue'
import { trpc } from '../lib/trpc'

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
  powerOnHours: number; powerCycles: number
  attributes: SmartAttr[]; nvme?: NvmeInfo
  _loading?: boolean; _error?: string
}

export type SmartStatus = 'unknown' | 'loading' | 'passed' | 'warning' | 'failed'

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
  if (!s.healthPassed) return 'failed'
  if (s.attributes.some(a => a.isCritical && a.raw > 0)) return 'warning'
  return 'passed'
}

/** Query SMART for one bare device name (sda, nvme0n1) and write it into `cache`,
 *  marking loading first and never throwing (records `_error` instead). */
export async function fetchSmartInto(
  cache: Ref<Record<string, SmartResult>>,
  device: string,
): Promise<void> {
  cache.value = { ...cache.value, [device]: emptySmart(device, { _loading: true }) }
  try {
    const res = await trpc.system.smartInfo.query({ device }) as SmartResult
    cache.value = { ...cache.value, [device]: res }
  } catch (e: unknown) {
    cache.value = {
      ...cache.value,
      [device]: emptySmart(device, { _error: (e as { message?: string })?.message ?? 'SMART query failed' }),
    }
  }
}
