<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRightIcon, CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from '@lucide/vue'
import { useSource } from '../../lib/widget-data'
import { trpc } from '../../lib/trpc'
import { requestApp } from '../../lib/app-focus'

// One line above the widgets: whether anything needs attention on the server,
// from the alerts HSI raises (disks, arrays, space, backups, certificate) and
// the update check. Shown to those who may read the alerts.

const props = defineProps<{ isAdmin: boolean; readonly?: boolean }>()
const { t } = useI18n()
const alerts = useSource('alerts', () => trpc.alert.list.query(), 60_000)
const update = props.isAdmin ? useSource('update', () => trpc.update.status.query(), 600_000) : null

const state = computed(() => {
  const list = alerts.data.value
  if (!list) return null
  const critical = list.filter(a => a.severity === 'critical')
  const warning = list.filter(a => a.severity !== 'critical')
  const first = critical[0] ?? warning[0]
  if (critical.length) return { tone: 'bad' as const, icon: CircleAlertIcon, text: t('widgets.band.critical', { n: critical.length }, critical.length), detail: first?.message, go: { app: 'monitor', section: undefined as string | undefined } }
  if (warning.length) return { tone: 'warn' as const, icon: TriangleAlertIcon, text: t('widgets.band.warning', { n: warning.length }, warning.length), detail: first?.message, go: { app: 'monitor', section: undefined as string | undefined } }
  const u = update?.data.value
  if (u?.hasUpdate && u.latest) return { tone: 'info' as const, icon: InfoIcon, text: t('widgets.band.update', { v: u.latest }), detail: undefined, go: { app: 'settings', section: 'updates' } }
  return { tone: 'ok' as const, icon: CircleCheckIcon, text: t('widgets.band.ok'), detail: undefined, go: null }
})

const TONE = {
  bad: 'border-error/40 bg-error/10 text-error',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  info: 'border-info/40 bg-info/10 text-info',
  ok: 'border-base-300 bg-base-100 text-success',
} as const
</script>

<template>
  <div v-if="state" role="status" :class="['flex min-h-11 items-center gap-3 rounded-box border px-4 py-2', TONE[state.tone]]">
    <component :is="state.icon" class="size-4 shrink-0" aria-hidden="true" />
    <p class="min-w-0 flex-1 text-sm">
      <span class="font-medium">{{ state.text }}</span>
      <span v-if="state.detail" class="ml-2 hidden text-base-content/80 sm:inline">{{ state.detail }}</span>
    </p>
    <button
      v-if="state.go && !readonly" type="button"
      class="btn btn-ghost btn-sm shrink-0 text-current"
      @click="requestApp(state.go.app, state.go.section)"
    >
      {{ t('widgets.band.see') }}<ArrowRightIcon class="size-4" aria-hidden="true" />
    </button>
  </div>
</template>
