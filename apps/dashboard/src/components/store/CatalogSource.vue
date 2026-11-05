<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCwIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { formatDateTime } from '../../lib/format-date'

// Where the App Store's apps come from (#26): this release's catalog or the
// newer signed one of the public catalog repository, with a check for
// administrators. Nothing about what anyone browses or installs is sent.
const emit = defineEmits<{ updated: [] }>()
const { t } = useI18n()
const { isAdmin } = useAuth()

type Source = {
  source: 'bundled' | 'online'; version: number; generatedAt: string | null; apps: number
  checkedAt?: string | null; error?: string | null; skipped?: { id: string; reason: string }[]
}
const info = ref<Source | null>(null)
const checking = ref(false)

async function load() {
  try { info.value = await trpc.catalog.source.query() as Source } catch { /* keep last */ }
}

async function check() {
  checking.value = true
  try {
    const before = info.value?.version
    info.value = await trpc.catalog.refresh.mutate() as Source
    if (info.value.version !== before) emit('updated')
  } catch (e: unknown) {
    if (info.value) info.value = { ...info.value, error: e instanceof Error ? e.message : String(e) }
  } finally {
    checking.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-if="info" class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/70">
    <span>
      {{ info.source === 'online' ? t('store.catalog.online', { date: info.generatedAt ? formatDateTime(info.generatedAt) : '' }) : t('store.catalog.bundled') }}
    </span>
    <template v-if="isAdmin">
      <span v-if="info.checkedAt">· {{ t('store.catalog.checked', { date: formatDateTime(info.checkedAt) }) }}</span>
      <Button variant="link" size="xs" class="h-auto p-0 text-xs" :disabled="checking" @click="check">
        <RefreshCwIcon :class="['size-3', checking && 'animate-spin']" aria-hidden="true" /> {{ t('store.catalog.check') }}
      </Button>
      <span v-if="info.error" role="status" class="basis-full text-warning">{{ info.error }}</span>
      <span v-if="info.skipped?.length" class="basis-full">
        {{ t('store.catalog.skipped', { count: info.skipped.length, list: info.skipped.map(s => `${s.id} (${s.reason})`).join(', ') }) }}
      </span>
    </template>
  </div>
</template>
