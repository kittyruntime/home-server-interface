<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DOT, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { now, useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const update = useSource('update', () => trpc.update.status.query(), 600_000)
const tls = useSource('tls', () => trpc.tls.status.query(), 600_000)
const apps = useSource('apps', () => trpc.container.app.list.query(), 30_000)
reportSources(update, apps)

type Row = { key: string; label: string; value: string; tone: Tone }
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const u = update.data.value
  if (u) out.push(u.hasUpdate && u.latest
    ? { key: 'hsi', label: 'HSI', value: t('widgets.updates.available', { v: u.latest }), tone: 'warn' }
    : { key: 'hsi', label: 'HSI', value: t('widgets.updates.upToDate', { v: u.current }), tone: 'ok' })
  const a = apps.data.value
  if (a) {
    const n = a.filter(x => x.catalogUpdate).length
    out.push({ key: 'apps', label: t('widgets.updates.apps'), value: n ? t('widgets.updates.appUpdates', { n }, n) : t('widgets.updates.appsUpToDate'), tone: n ? 'warn' : 'ok' })
  }
  const cert = tls.data.value?.certificate
  if (cert && tls.data.value?.mode !== 'off') {
    const days = Math.floor((new Date(cert.notAfter).getTime() - now.value) / 86_400_000)
    out.push({
      key: 'tls', label: t('widgets.updates.certificate'),
      value: days < 0 ? t('widgets.updates.expired') : t('widgets.updates.expiresIn', { n: days }, days),
      tone: days < 7 ? 'bad' : days < 30 ? 'warn' : 'ok',
    })
  }
  return out
})
</script>

<template>
  <ul class="flex flex-1 flex-col justify-center divide-y divide-base-300">
    <li v-for="r in rows" :key="r.key" class="flex items-center gap-2 py-2 text-xs first:pt-0 last:pb-0">
      <span :class="['size-2 shrink-0 rounded-full', DOT[r.tone]]" aria-hidden="true" />
      <span class="w-20 shrink-0 text-base-content/70">{{ r.label }}</span>
      <span :class="['min-w-0 flex-1 truncate font-medium', r.tone === 'ok' ? 'text-base-content' : TEXT[r.tone]]">{{ r.value }}</span>
    </li>
  </ul>
</template>
