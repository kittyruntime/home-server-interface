<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeftIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import LoadingState from '../ui/LoadingState.vue'
import ConnectBlock from './ConnectBlock.vue'
import ShareAccess from './ShareAccess.vue'
import ShareSessions from './ShareSessions.vue'
import ShareActivity from './ShareActivity.vue'
import ShareChecks from './ShareChecks.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import type { ConnectInfo, ShareDetailData, ShareSession } from '../../lib/sharing-types'

const props = defineProps<{ id: string; connect: ConnectInfo; narrow: boolean }>()
const emit = defineEmits<{
  back: []
  edit: [share: ShareDetailData['share']]
  changed: []
  removed: []
  seeAll: [share: string]
}>()

const { t } = useI18n()
const { confirm } = useConfirm()
const toast = useToast()

const data = ref<ShareDetailData | null>(null)
const error = ref('')
const loading = ref(true)
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    data.value = await trpc.sharing.detail.query({ id: props.id })
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message || t('sharing.detail.loadFailed')
  } finally {
    loading.value = false
  }
}

watch(() => props.id, () => { loading.value = true; data.value = null; void load() })
onMounted(() => {
  void load()
  // Sessions come and go: keep the detail current while it is open.
  timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

async function toggle() {
  const s = data.value?.share
  if (!s) return
  try {
    await applyPlanned('share.update', { id: s.id, enabled: !s.enabled }, {
      domain: 'sharing',
      title: s.enabled ? t('sharing.detail.disablePlan', { name: s.name }) : t('sharing.detail.enablePlan', { name: s.name }),
      actionLabel: s.enabled ? t('sharing.detail.disable') : t('sharing.detail.enable'),
      danger: s.enabled,
    })
    await load()
    emit('changed')
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  }
}

async function remove() {
  const s = data.value?.share
  if (!s) return
  try {
    await applyPlanned('share.remove', { id: s.id }, {
      domain: 'sharing', title: t('sharing.detail.removePlan', { name: s.name }), actionLabel: t('sharing.detail.stopSharing'), danger: true,
    })
    emit('removed')
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  }
}

async function disconnect(session: ShareSession) {
  const share = data.value?.share.name ?? ''
  const user = session.user || 'guest'
  if (!await confirm(t('sharing.detail.disconnectConfirm', { user, share }), { confirmLabel: t('sharing.detail.disconnect'), danger: true })) return
  try {
    await trpc.sharing.disconnect.mutate({ pid: session.pid! })
    toast.success(t('sharing.detail.disconnected', { user }))
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  }
  await load()
}
</script>

<template>
  <div class="space-y-5 p-4 @3xl:p-6">
    <button v-if="narrow" type="button" class="flex items-center gap-1 text-sm text-primary" @click="emit('back')">
      <ChevronLeftIcon class="size-4" />{{ t('sharing.detail.back') }}
    </button>

    <LoadingState v-if="loading && !data" variant="compact" />
    <Alert v-else-if="error && !data" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-if="data">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="min-w-0 flex-1 basis-40">
          <div class="flex items-center gap-2">
            <h3 class="truncate text-base font-semibold text-base-content">{{ data.share.name }}</h3>
            <Badge :variant="data.share.enabled ? 'default' : 'secondary'">{{ data.share.enabled ? t('sharing.detail.active') : t('sharing.detail.disabled') }}</Badge>
          </div>
          <p class="truncate text-xs text-base-content/70">{{ data.share.placeName }} · {{ data.share.placePath }}</p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-1.5">
          <Button variant="outline" size="xs" @click="emit('edit', data.share)">{{ t('sharing.detail.edit') }}</Button>
          <Button variant="ghost" size="xs" @click="toggle">{{ data.share.enabled ? t('sharing.detail.disable') : t('sharing.detail.enable') }}</Button>
          <Button variant="ghost" size="xs" class="text-error" @click="remove">{{ t('sharing.detail.delete') }}</Button>
        </div>
      </header>

      <p v-if="data.share.hidden" class="text-xs text-base-content/70">{{ t('sharing.detail.hiddenNote') }}</p>

      <ConnectBlock :share="data.share.name" :guest-ok="data.share.guestOk" v-bind="connect" />
      <ShareAccess :access="data.access" />
      <ShareSessions :sessions="data.sessions" can-disconnect @disconnect="disconnect" />
      <ShareActivity :events="data.recent" show-user see-all @see-all="emit('seeAll', data.share.name)" />
      <ShareChecks :checks="data.checks" :read-only="data.share.readOnly" />
    </template>
  </div>
</template>
