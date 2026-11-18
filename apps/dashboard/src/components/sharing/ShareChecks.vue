<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheckIcon, TriangleAlertIcon } from '@lucide/vue'
import type { ShareDetailData } from '../../lib/sharing-types'

const props = defineProps<{ checks: ShareDetailData['checks']; readOnly: boolean }>()
const { t } = useI18n()

const lines = computed(() => {
  const c = props.checks
  const out: { ok: boolean; text: string }[] = []
  if (c.dirExists === false) out.push({ ok: false, text: t('sharing.detail.dirMissing') })
  else if (c.dirOk === false && !props.readOnly) out.push({ ok: false, text: t('sharing.detail.dirNotWritable') })
  else if (c.dirOk) out.push({ ok: true, text: t('sharing.detail.dirOk') })
  if (c.nobodyCanWrite) out.push({ ok: false, text: t('sharing.detail.nobodyCanWrite') })
  for (const e of c.excluded) out.push({ ok: false, text: t('sharing.detail.excluded', { user: e.username, reason: e.reason }) })
  return out
})
</script>

<template>
  <section v-if="lines.length" class="space-y-2">
    <h4 class="text-sm font-semibold text-base-content">{{ t('sharing.detail.checks') }}</h4>
    <ul class="space-y-1">
      <li v-for="(l, i) in lines" :key="i" class="flex items-start gap-2 text-sm" :class="l.ok ? 'text-base-content/80' : 'text-warning'">
        <CircleCheckIcon v-if="l.ok" class="mt-0.5 size-4 shrink-0 text-success" />
        <TriangleAlertIcon v-else class="mt-0.5 size-4 shrink-0" />
        {{ l.text }}
      </li>
    </ul>
  </section>
</template>
