import { computed, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { groupProcesses, matchesProcess, sortProcesses, type RankMetric } from '../../../lib/perf-math'
import { procs, type ProcessRow } from '../../../lib/proc-live'
import { useRanking } from '../../../lib/use-ranking'
import { appLook, loadAppLooks } from '../../../lib/app-icons'
import { METRICS, METRIC_COLOR, OWNER_ICON, metricLevel, metricText, ownerName } from './owners'

const SORT_KEY = { cpu: 'cpu', rss: 'rss', disk: 'disk' } as const

/** The owners of the running processes, ranked by a metric, ready to draw. */
export function useOwners(metric: Ref<RankMetric>, query: Ref<string> = computed(() => '')) {
  const { t } = useI18n()
  void loadAppLooks()
  const groups = computed(() => groupProcesses(procs.value.filter(p => matchesProcess(p, query.value))))
  const { ranked, lit } = useRanking(groups, metric, query)

  const others = computed(() => METRICS.filter(m => m !== metric.value))
  // Bars measure against the busiest owner, so the ranking reads at a glance
  // even on a quiet server; the figure beside each bar gives the real value.
  const leader = computed(() => Math.max(0, ...groups.value.map(g => g[metric.value])))

  const valueOf = (p: ProcessRow, m: RankMetric) => m === 'disk' ? p.readBps + p.writeBps : p[m]

  const rows = computed(() => ranked.value.map(g => ({
    key: g.key,
    kind: g.kind,
    icon: OWNER_ICON[g.kind],
    // An app shows its own icon (catalog logo or the one picked for it).
    tile: g.kind === 'app' ? { ...appLook(g.owner), name: g.owner } : null,
    name: (g.kind === 'app' && appLook(g.owner)?.label) || ownerName(g.kind, g.owner, t),
    sub: `${t(`monitor.owners.kind.${g.kind}`)} · ${t('monitor.owners.count', { n: g.procs.length }, g.procs.length)}`,
    level: metricLevel(g[metric.value], leader.value),
    value: metricText(metric.value, g[metric.value]),
    color: METRIC_COLOR[metric.value],
    others: others.value.map(m => metricText(m, g[m])),
    procs: sortProcesses(g.procs, SORT_KEY[metric.value], 'desc').map(p => ({
      row: p,
      level: metricLevel(valueOf(p, metric.value), leader.value),
      value: metricText(metric.value, valueOf(p, metric.value)),
      others: others.value.map(m => metricText(m, valueOf(p, m))),
    })),
  })))

  return { rows, lit, others }
}
