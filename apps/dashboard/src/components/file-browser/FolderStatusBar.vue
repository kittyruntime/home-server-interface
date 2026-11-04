<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { trpc } from '../../lib/trpc'
import { formatBytes } from '../../lib/file-details'

// Below the listing (#201): how many items, and how much room is left on the
// disk the current folder lives on. Places have no enforced limit, so the
// free space of their volume is the limit people see.
const props = defineProps<{ path: string | null; items: number; selected: number }>()
const { t } = useI18n()

type Usage = { total: number; free: number; fsType?: string; mountPoint?: string; source?: string }
const usage = ref<Usage | null>(null)
let seq = 0

watch(() => props.path, async path => {
  const mine = ++seq
  if (!path) { usage.value = null; return }
  try {
    const u = await trpc.fs.diskUsage.query({ path })
    if (mine === seq) usage.value = u
  } catch {
    if (mine === seq) usage.value = null
  }
}, { immediate: true })

const usedPct = computed(() => usage.value && usage.value.total > 0 ? (1 - usage.value.free / usage.value.total) * 100 : 0)
</script>

<template>
  <div v-if="path" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-base-300 bg-base-100 px-3 py-1.5 text-xs text-base-content/70" @click.stop>
    <span class="tabular-nums">
      {{ t('files.status.items', { count: items }) }}<template v-if="selected"> · {{ t('files.status.selected', { count: selected }) }}</template>
    </span>
    <span v-if="usage" class="ml-auto flex items-center gap-2" :title="usage.mountPoint ? t('files.status.volume', { mount: usage.mountPoint }) : undefined">
      <progress :class="['progress h-1.5 w-20', usedPct > 90 ? 'progress-error' : usedPct > 75 ? 'progress-warning' : 'progress-primary']" :value="usedPct" max="100" :aria-label="t('files.status.used', { pct: Math.round(usedPct) })" />
      <span class="tabular-nums">{{ t('files.status.free', { free: formatBytes(usage.free), total: formatBytes(usage.total) }) }}</span>
    </span>
  </div>
</template>
