<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownIcon, ArrowUpIcon } from '@lucide/vue'
import Spark from '../kit/Spark.vue'
import { rxHist, txHist, useLive } from '../kit/live'
import { reportSources } from '../card-status'
import { fmtRate } from '../../../lib/perf-math'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const live = useLive()
reportSources(live)
const net = computed(() => live.data.value?.network)
const top = computed(() => Math.max(1024, ...rxHist.value, ...txHist.value))
</script>

<template>
  <div class="flex flex-1 flex-col justify-end gap-3">
    <div class="grid grid-cols-2 gap-3">
      <div class="min-w-0">
        <p class="flex items-center gap-1 text-xs text-base-content/70"><ArrowDownIcon class="size-3.5" aria-hidden="true" />{{ t('widgets.network.in') }}</p>
        <p class="mt-1 truncate font-figure text-lg font-bold tabular-nums text-base-content">{{ net ? fmtRate(net.rx) : '-' }}</p>
      </div>
      <div class="min-w-0">
        <p class="flex items-center gap-1 text-xs text-base-content/70"><ArrowUpIcon class="size-3.5" aria-hidden="true" />{{ t('widgets.network.out') }}</p>
        <p class="mt-1 truncate font-figure text-lg font-bold tabular-nums text-base-content">{{ net ? fmtRate(net.tx) : '-' }}</p>
      </div>
    </div>
    <div class="relative h-10">
      <div class="absolute inset-0"><Spark :values="rxHist" :max="top" /></div>
      <div class="absolute inset-0"><Spark :values="txHist" :max="top" color="var(--color-secondary)" :fill="false" /></div>
    </div>
  </div>
</template>
