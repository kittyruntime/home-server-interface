<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckIcon, CopyIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { copyText } from '../../lib/copy-text'
import { useToast } from '../../lib/toast'

// Addresses or commands to copy, one per system; the copied row shows a
// check for a moment, where the click happened.
defineProps<{ items: { key: string; label: string; address: string }[] }>()
const { t } = useI18n()
const toast = useToast()

const copied = ref<string | null>(null)
let reset: ReturnType<typeof setTimeout> | null = null
onUnmounted(() => { if (reset) clearTimeout(reset) })

async function copy(key: string, address: string) {
  if (!await copyText(address)) {
    toast.error(t('sharing.detail.copyFailed'))
    return
  }
  copied.value = key
  if (reset) clearTimeout(reset)
  reset = setTimeout(() => { copied.value = null }, 1600)
}
</script>

<template>
  <span class="sr-only" aria-live="polite">{{ copied ? t('sharing.detail.copied') : '' }}</span>
  <ul class="space-y-1.5">
    <li v-for="a in items" :key="a.key" class="flex min-w-0 items-center gap-2">
      <span class="w-16 shrink-0 text-xs text-base-content/70">{{ a.label }}</span>
      <code class="min-w-0 flex-1 truncate rounded-field bg-base-200 px-2 py-1 font-mono text-xs text-base-content select-all" :title="a.address">{{ a.address }}</code>
      <Button variant="ghost" size="xs" class="shrink-0" :aria-label="copied === a.key ? t('sharing.detail.copied') : t('sharing.detail.copyWhat', { os: a.label })" @click="copy(a.key, a.address)">
        <CheckIcon v-if="copied === a.key" class="size-3.5 text-success" />
        <CopyIcon v-else class="size-3.5" />
      </Button>
    </li>
  </ul>
</template>
