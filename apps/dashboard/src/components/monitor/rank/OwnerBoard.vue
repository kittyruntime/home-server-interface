<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRightIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import LoadingState from '../../ui/LoadingState.vue'
import OwnerRow from './OwnerRow.vue'
import { METRICS, RANK_GRID } from './owners'
import { useOwners } from './use-owners'
import { procsError, procsLoaded, subscribeProcs } from '../../../lib/proc-live'
import type { RankMetric } from '../../../lib/perf-math'

// The overview's answer to "what is using the server": the busiest owners,
// reranked live. Picking one opens it in the Processes section.
const SHOWN = 6
const emit = defineEmits<{ open: [key: string | null] }>()
const { t } = useI18n()
const metric = ref<RankMetric>('cpu')
const { rows, lit, others } = useOwners(metric)
const top = computed(() => rows.value.slice(0, SHOWN))

let stop: (() => void) | null = null
onMounted(() => { stop = subscribeProcs() })
onUnmounted(() => stop?.())
</script>

<template>
  <Card class="@container gap-0 p-0">
    <header class="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-2 @2xl:px-5">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-base-content">{{ t('monitor.owners.title') }}</h3>
        <p class="text-xs text-base-content/70">{{ t('monitor.owners.subtitle') }}</p>
      </div>
      <ToggleGroup type="single" variant="tabs" size="sm" :model-value="metric" :aria-label="t('monitor.owners.rankBy')"
        @update:model-value="v => { if (typeof v === 'string' && v) metric = v as RankMetric }">
        <ToggleGroupItem v-for="m in METRICS" :key="m" :value="m">{{ t(`monitor.owners.metric.${m}`) }}</ToggleGroupItem>
      </ToggleGroup>
    </header>

    <div :class="[RANK_GRID, 'px-6 pb-1 text-2xs font-medium uppercase tracking-caps text-base-content/60 @2xl:px-8']" aria-hidden="true">
      <span>{{ t('monitor.owners.owner') }}</span>
      <span class="text-right">{{ t(`monitor.owners.metric.${metric}`) }}</span>
      <span v-for="m in others" :key="m" class="hidden text-right @xl:block">{{ t(`monitor.owners.metric.${m}`) }}</span>
    </div>

    <LoadingState v-if="!procsLoaded" variant="block" />
    <p v-else-if="procsError && !rows.length" class="px-5 py-8 text-center text-sm text-base-content/70">{{ t('monitor.proc.loadFailed') }}</p>
    <TransitionGroup v-else tag="ol" class="px-3 @2xl:px-5" move-class="transition-transform duration-(--dur-slow) ease-out">
      <li v-for="r in top" :key="r.key">
        <OwnerRow :icon="r.icon" :tile="r.tile" :name="r.name" :sub="r.sub" :level="r.level" :value="r.value" :color="r.color"
          :others="r.others" :lit="lit.has(r.key)" @activate="emit('open', r.key)" />
      </li>
    </TransitionGroup>

    <footer class="flex items-center justify-between gap-3 border-t border-base-300/70 px-4 py-2 @2xl:px-5">
      <span class="text-xs text-base-content/70">{{ t('monitor.owners.more', { n: Math.max(0, rows.length - SHOWN) }, Math.max(0, rows.length - SHOWN)) }}</span>
      <Button variant="ghost" size="sm" @click="emit('open', null)">
        {{ t('monitor.owners.all') }}<ArrowRightIcon class="size-4" aria-hidden="true" />
      </Button>
    </footer>
  </Card>
</template>
