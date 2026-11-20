import { onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { climbers, rankGroups, type RankMetric } from './perf-math'

const LIT_MS = 1600

/**
 * Keeps a ranking steady between refreshes and remembers, for a moment, the
 * rows that just climbed so they can be lit while they move.
 */
export function useRanking<G extends { key: string } & Record<RankMetric, number>>(groups: Ref<G[]>, metric: Ref<RankMetric>, filter?: Ref<string>) {
  const ranked = shallowRef<G[]>([])
  const lit = ref(new Set<string>())
  let order: string[] = []
  let lastMetric = metric.value
  let lastFilter = filter?.value
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  watch([groups, metric], () => {
    // A new metric or a new search reorders everything: that is not a climb.
    const metricChanged = lastMetric !== metric.value || lastFilter !== filter?.value
    lastMetric = metric.value
    lastFilter = filter?.value
    const next = rankGroups(groups.value, metric.value, metricChanged ? [] : order)
    const keys = next.map(g => g.key)
    if (!metricChanged) {
      for (const k of climbers(order, keys)) {
        clearTimeout(timers.get(k))
        lit.value.add(k)
        timers.set(k, setTimeout(() => { lit.value.delete(k); timers.delete(k) }, LIT_MS))
      }
    }
    order = keys
    ranked.value = next
  }, { immediate: true })

  onUnmounted(() => { for (const t of timers.values()) clearTimeout(t) })
  return { ranked, lit }
}
