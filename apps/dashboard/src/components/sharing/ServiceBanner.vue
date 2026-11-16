<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import BusyLabel from '../ui/BusyLabel.vue'
import { trpc } from '../../lib/trpc'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import type { SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null; loading: boolean }>()
const emit = defineEmits<{ refresh: [] }>()

const { t } = useI18n()
const { confirm } = useConfirm()
const toast = useToast()
const busy = ref(false)

const state = computed(() => {
  const s = props.service?.state
  if (!s) return props.loading ? 'checking' : 'unknown'
  if (!s.installed) return 'missing'
  return s.active ? 'on' : 'stopped'
})

const name = computed(() => props.service?.settings.netbiosName || '')

async function act(action: 'start' | 'restart') {
  if (action === 'restart' && !await confirm(t('sharing.banner.restartConfirm'), { confirmLabel: t('sharing.banner.restart') })) return
  busy.value = true
  try {
    await trpc.sharing.serviceAction.mutate({ action })
    toast.success(t('sharing.banner.done'))
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  } finally {
    busy.value = false
    emit('refresh')
  }
}
</script>

<template>
  <Card class="flex flex-row flex-wrap items-center gap-x-4 gap-y-3 p-4">
    <span class="size-2.5 shrink-0 rounded-full" aria-hidden="true" :class="{
      'animate-pulse bg-base-content/30': state === 'checking',
      'bg-success shadow-[0_0_0_4px] shadow-success/20': state === 'on',
      'bg-warning': state === 'stopped',
      'bg-error': state === 'missing' || state === 'unknown',
    }" />
    <div class="min-w-0 flex-1 basis-56">
      <p class="text-sm font-semibold text-base-content" role="status">{{ t(`sharing.banner.${state}`) }}</p>
      <p v-if="state === 'on'" class="text-xs text-base-content/70">
        <span v-if="name">{{ t('sharing.banner.announcedAs', { name }) }} · </span>
        {{ t('sharing.banner.connected', { n: service?.connectedCount ?? 0 }, service?.connectedCount ?? 0) }}
      </p>
      <p v-else-if="state === 'missing'" class="text-xs text-base-content/80">{{ t('sharing.banner.missingHelp') }}</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <a v-if="state === 'missing'" class="link link-primary text-xs" href="https://kittyruntime.github.io/home-server-interface/guide/features/users-shares/" target="_blank" rel="noopener">{{ t('sharing.banner.docs') }}</a>
      <Button v-if="state === 'missing' || state === 'unknown'" variant="outline" size="sm" :disabled="loading" @click="emit('refresh')">
        <BusyLabel :busy="loading">{{ t('sharing.banner.checkAgain') }}</BusyLabel>
      </Button>
      <Button v-else-if="state === 'stopped'" size="sm" :disabled="busy" @click="act('start')">
        <BusyLabel :busy="busy">{{ t('sharing.banner.start') }}</BusyLabel>
      </Button>
      <Button v-else-if="state === 'on'" variant="outline" size="sm" :disabled="busy" @click="act('restart')">
        <BusyLabel :busy="busy">{{ t('sharing.banner.restart') }}</BusyLabel>
      </Button>
    </div>
  </Card>
</template>
