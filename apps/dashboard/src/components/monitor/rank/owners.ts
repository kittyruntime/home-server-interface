import type { Component } from 'vue'
import { BoxIcon, CogIcon, ServerIcon, UserIcon } from '@lucide/vue'
import { fmtRate, type ProcessKind, type RankMetric } from '../../../lib/perf-math'
import { formatBytes } from '../../../lib/file-details'
import { RESOURCE_COLOR } from '../../../lib/perf-live'

// What the ranking shows for each kind of owner and each metric.

export const OWNER_ICON: Record<ProcessKind, Component> = { system: CogIcon, hsi: ServerIcon, app: BoxIcon, user: UserIcon }

export const METRICS: RankMetric[] = ['cpu', 'rss', 'disk']

export const METRIC_COLOR: Record<RankMetric, string> = { cpu: RESOURCE_COLOR.cpu, rss: RESOURCE_COLOR.mem, disk: RESOURCE_COLOR.disk }

export function ownerName(kind: ProcessKind, owner: string, t: (k: string) => string): string {
  if (kind === 'system') return t('monitor.owners.system')
  if (kind === 'hsi') return 'HSI'
  return owner
}

export function metricText(metric: RankMetric, value: number): string {
  if (metric === 'cpu') return `${value < 10 ? value.toFixed(1) : Math.round(value)} %`
  return metric === 'rss' ? formatBytes(value) : fmtRate(value)
}

/** How full a bar is, 0 to 100, against the busiest owner. */
export function metricLevel(value: number, leader: number): number {
  return leader > 0 ? Math.max(0, Math.min(100, (value / leader) * 100)) : 0
}

/** Columns shared by the header, the owners and their processes. */
export const RANK_GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(6.5rem,9rem)] items-center gap-x-4 @xl:grid-cols-[minmax(0,1fr)_minmax(9rem,15rem)_5.5rem_5.5rem]'
