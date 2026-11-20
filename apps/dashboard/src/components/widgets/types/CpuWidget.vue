<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Figure from '../kit/Figure.vue'
import Spark from '../kit/Spark.vue'
import { TEXT, toneOf } from '../kit/tone'
import { cpuHist, useLive } from '../kit/live'
import { reportSources } from '../card-status'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const live = useLive()
reportSources(live)

const cpu = computed(() => live.data.value?.cpu)
const uptime = computed(() => {
  const s = live.data.value?.uptime ?? 0
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? t('widgets.uptime.days', { d, h }) : h > 0 ? t('widgets.uptime.hours', { h, m }) : t('widgets.uptime.minutes', { m })
})
</script>

<template>
  <div class="flex flex-1 items-end gap-4">
    <Figure :value="cpu ?? '-'" unit="%" :sub="live.data.value ? uptime : undefined" :tone-class="cpu != null && cpu >= 90 ? TEXT[toneOf(cpu)] : undefined" />
    <div class="h-12 min-w-0 flex-1">
      <Spark :values="cpuHist" :max="100" :label="t('widgets.types.cpu.title')" />
    </div>
  </div>
</template>
