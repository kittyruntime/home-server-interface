<script setup lang="ts">
import { computed, reactive } from 'vue'
import WidgetBody from '../dashboard/WidgetBody.vue'
import { useDashboardWidgets, catalogFor, type Widget } from '../../lib/dashboard-widgets'
import { useAuth } from '../../lib/auth'

defineEmits<{
  'contextmenu-widget': [widget: Widget, event: MouseEvent]
}>()

const {
  widgets, metrics,
  cpuHist, rxHist, txHist,
  ctrRunning, ctrStopped, ctrError,
  disks, sysinfo, smart, smartDevices,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const { isAdmin, hasCapability } = useAuth()
const addableTypes = computed(() =>
  catalogFor(isAdmin.value, cap => hasCapability(cap).value).filter(cat => !widgets.value.some(w => w.type === cat.type))
)

// What every widget body reads (reactive() unwraps the refs for v-bind).
const body = reactive({ metrics, cpuHist, rxHist, txHist, ctrRunning, ctrStopped, ctrError, disks, sysinfo, smart, smartDevices })

defineExpose({ addableTypes, addWidget, removeWidget, toggleCols })
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-6">
    <div
      v-for="w in widgets" :key="w.id"
      :class="['relative bg-base-200/90 border border-base-300 rounded-box p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-2' : 'col-span-1']"
      @contextmenu="$emit('contextmenu-widget', w, $event)"
    >
      <WidgetBody :w="w" v-bind="body" />
    </div>
  </div>
</template>
