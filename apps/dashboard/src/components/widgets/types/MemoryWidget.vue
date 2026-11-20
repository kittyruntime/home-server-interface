<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Figure from '../kit/Figure.vue'
import Meter from '../kit/Meter.vue'
import Spark from '../kit/Spark.vue'
import { memHist, useLive } from '../kit/live'
import { reportSources } from '../card-status'
import { formatBytes } from '../../../lib/file-details'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const live = useLive()
reportSources(live)
const mem = computed(() => live.data.value?.memory)
</script>

<template>
  <div class="flex flex-1 flex-col justify-end gap-3">
    <div class="flex items-end gap-4">
      <Figure :value="mem ? mem.percent : '-'" unit="%" :sub="mem ? t('widgets.ofTotal', { used: formatBytes(mem.used), total: formatBytes(mem.total) }) : undefined" />
      <div v-if="props.size !== 's'" class="h-12 min-w-0 flex-1">
        <Spark :values="memHist" :max="100" color="var(--color-secondary)" />
      </div>
    </div>
    <Meter v-if="mem" :value="mem.percent" :warn="80" :bad="92" :label="t('widgets.types.memory.title')" />
  </div>
</template>
