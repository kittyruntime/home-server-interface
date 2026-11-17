<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeftIcon, HistoryIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import LoadingState from '../ui/LoadingState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import ConnectBlock from './ConnectBlock.vue'
import NfsBlock from './NfsBlock.vue'
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
// The action running on this share, so its button shows it and the others wait.
const pending = ref<'toggle' | 'remove' | null>(null)
const disconnecting = ref<string | null>(null)

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
  if (!s || pending.value) return
  pending.value = 'toggle'
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
  } finally {
    pending.value = null
  }
}

async function remove() {
  const s = data.value?.share
  if (!s || pending.value) return
  pending.value = 'remove'
  try {
    await applyPlanned('share.remove', { id: s.id }, {
      domain: 'sharing', title: t('sharing.detail.removePlan', { name: s.name }), actionLabel: t('sharing.detail.stopSharing'), danger: true,
    })
    emit('removed')
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  } finally {
    pending.value = null
  }
}

async function disconnect(session: ShareSession) {
  const share = data.value?.share.name ?? ''
  const user = session.user || t('sharing.detail.guest')
  if (!await confirm(t('sharing.detail.disconnectConfirm', { user, share }), { confirmLabel: t('sharing.detail.disconnect'), danger: true })) return
  disconnecting.value = `${session.share}|${session.user}|${session.ip || session.client}`
  try {
    await trpc.sharing.disconnect.mutate({ pids: session.pids })
    toast.success(t('sharing.detail.disconnected', { user }))
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  }
  await load()
  disconnecting.value = null
}
</script>

<template>
  <div class="space-y-5 p-4 @3xl:p-6">
    <Button v-if="narrow" variant="ghost" size="sm" class="-ml-2 gap-1 text-primary" @click="emit('back')">
      <ChevronLeftIcon class="size-4" />{{ t('sharing.detail.back') }}
    </Button>

    <LoadingState v-if="loading && !data" variant="compact" />
    <Alert v-else-if="error && !data" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-if="data">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="min-w-0 flex-1 basis-40">
          <div class="flex items-center gap-2">
            <h3 class="truncate text-base font-semibold text-base-content">{{ data.share.name }}</h3>
            <Badge v-if="data.share.enabled" variant="outline" class="bg-success/10 text-success">{{ t('sharing.detail.active') }}</Badge>
            <Badge v-else variant="secondary">{{ t('sharing.detail.disabled') }}</Badge>
          </div>
          <p class="truncate text-xs text-base-content/70" :title="data.share.placePath">{{ data.share.placeName }} · <span class="font-mono">{{ data.share.placePath }}</span></p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-1.5">
          <Button variant="outline" size="xs" :disabled="!!pending" @click="emit('edit', data.share)">{{ t('sharing.detail.edit') }}</Button>
          <Button variant="ghost" size="xs" :disabled="!!pending" @click="toggle">
            <BusyLabel :busy="pending === 'toggle'">{{ data.share.enabled ? t('sharing.detail.disable') : t('sharing.detail.enable') }}</BusyLabel>
          </Button>
          <Button variant="ghost" size="xs" class="text-error" :disabled="!!pending" @click="remove">
            <BusyLabel :busy="pending === 'remove'">{{ t('sharing.detail.delete') }}</BusyLabel>
          </Button>
        </div>
      </header>

      <p v-if="data.share.hidden" class="text-xs text-base-content/70">{{ t('sharing.detail.hiddenNote') }}</p>
      <div v-if="data.share.timeMachine" class="flex items-start gap-3 rounded-box border border-base-300 bg-base-200/50 p-3">
        <HistoryIcon class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0 space-y-0.5">
          <p class="text-sm font-medium text-base-content">
            {{ t('sharing.detail.timeMachineOption') }}<span v-if="data.share.timeMachineMaxGb" class="font-normal text-base-content/70"> · {{ t('sharing.detail.upTo', { n: data.share.timeMachineMaxGb }) }}</span>
          </p>
          <p class="text-xs text-base-content/70">{{ t('sharing.detail.timeMachineHowTo') }}</p>
        </div>
      </div>

      <ConnectBlock v-if="data.share.smb" :share="data.share.name" :guest-ok="data.share.guestOk" v-bind="connect"
        :title="data.share.nfs ? t('sharing.detail.connectSmb') : undefined" />
      <NfsBlock v-if="data.share.nfs && data.nfs" :share="data.share.name" :path="data.share.placePath"
        :clients="data.share.nfsClients" :write-as="data.nfs.writeAs" :connected="data.nfs.clients" />
      <ShareAccess :access="data.access" />
      <template v-if="data.share.smb">
        <ShareSessions :sessions="data.sessions" can-disconnect :busy-key="disconnecting" @disconnect="disconnect" />
        <ShareActivity :events="data.recent" :sessions="data.sessions" show-user see-all :max-lines="6" @see-all="emit('seeAll', data.share.name)" />
      </template>
      <ShareChecks :checks="data.checks" :read-only="data.share.readOnly" />
    </template>
  </div>
</template>
