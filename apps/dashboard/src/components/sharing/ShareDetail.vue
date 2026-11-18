<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { HistoryIcon, KeyRoundIcon, MonitorIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import LoadingState from '../ui/LoadingState.vue'
import ConnectBlock from './ConnectBlock.vue'
import NfsBlock from './NfsBlock.vue'
import SftpBlock from './SftpBlock.vue'
import ShareAccess from './ShareAccess.vue'
import ShareSessions from './ShareSessions.vue'
import ShareActivity from './ShareActivity.vue'
import ShareChecks from './ShareChecks.vue'
import { useAuth } from '../../lib/auth'
import { trpc } from '../../lib/trpc'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import type { ConnectInfo, ShareDetailData, ShareSession } from '../../lib/sharing-types'

const props = defineProps<{ id: string; connect: ConnectInfo }>()
const emit = defineEmits<{ loaded: [share: ShareDetailData['share']]; seeAll: [share: string] }>()

const { t } = useI18n()
const { currentUsername } = useAuth()
const { confirm } = useConfirm()
const toast = useToast()

const data = ref<ShareDetailData | null>(null)
const error = ref('')
const loading = ref(true)
let timer: ReturnType<typeof setInterval> | null = null
const disconnecting = ref<string | null>(null)

type Tab = 'connect' | 'access' | 'activity'
const tab = ref<Tab>('connect')

async function load() {
  try {
    data.value = await trpc.sharing.detail.query({ id: props.id })
    error.value = ''
    emit('loaded', data.value.share)
  } catch (e) {
    error.value = (e as Error).message || t('sharing.detail.loadFailed')
  } finally {
    loading.value = false
  }
}
defineExpose({ reload: load })

watch(() => props.id, () => { loading.value = true; data.value = null; void load() })
onMounted(() => {
  void load()
  // Sessions come and go: keep the detail current while it is open.
  timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

// People on it now over every protocol, counted like the list does.
const live = computed(() => data.value?.connected ?? 0)
const warnings = computed(() => {
  const d = data.value
  if (!d) return 0
  const c = d.checks
  return (c.dirExists === false || (c.dirOk === false && !d.share.readOnly) ? 1 : 0) + (c.nobodyCanWrite ? 1 : 0) + c.excluded.length
    + d.access.filter(a => !a.networkPassword).length
})

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
  <div>
    <LoadingState v-if="loading && !data" variant="compact" />
    <Alert v-else-if="error && !data" variant="destructive" class="m-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-if="data">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-4 @3xl:px-5">
        <h3 class="min-w-0 truncate text-base font-semibold text-base-content">{{ data.share.name }}</h3>
        <Badge v-if="data.share.enabled" variant="outline" class="bg-success/10 text-success">{{ t('sharing.detail.active') }}</Badge>
        <Badge v-else variant="secondary">{{ t('sharing.detail.disabled') }}</Badge>
        <p class="w-full truncate text-xs text-base-content/70" :title="data.share.placePath">{{ data.share.placeName }} · <span class="font-mono">{{ data.share.placePath }}</span></p>
      </header>

      <Tabs v-model="tab">
        <div class="mt-3 border-b border-base-300 px-4 @3xl:px-5">
          <TabsList :aria-label="t('sharing.detail.sections')" variant="border">
            <TabsTrigger value="connect" class="flex-none px-3">{{ t('sharing.detail.connect') }}</TabsTrigger>
            <TabsTrigger value="access" class="flex-none px-3">
              {{ t('sharing.detail.access') }}
              <span v-if="warnings" class="badge badge-warning badge-xs tabular-nums">{{ warnings }}</span>
            </TabsTrigger>
            <TabsTrigger value="activity" class="flex-none px-3">
              {{ t('sharing.detail.activity') }}
              <span v-if="live" class="badge badge-success badge-soft badge-xs tabular-nums">{{ live }}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <div class="p-4 @3xl:p-5">
          <TabsContent value="connect" class="space-y-6">
            <div v-if="data.share.timeMachine" class="flex items-start gap-3 rounded-box bg-base-200/60 p-3">
              <HistoryIcon class="mt-0.5 size-4 shrink-0 text-base-content/70" aria-hidden="true" />
              <div class="min-w-0 space-y-0.5">
                <p class="text-sm font-medium text-base-content">
                  {{ t('sharing.detail.timeMachineOption') }}<span v-if="data.share.timeMachineMaxGb" class="font-normal text-base-content/70"> · {{ t('sharing.detail.upTo', { n: data.share.timeMachineMaxGb }) }}</span>
                </p>
                <p class="text-xs text-base-content/70">{{ t('sharing.detail.timeMachineHowTo') }}</p>
              </div>
            </div>
            <ConnectBlock v-if="data.share.smb" :share="data.share.name" :guest-ok="data.share.guestOk" v-bind="connect" title="SMB" />
            <p v-if="data.share.smb && data.share.hidden" class="-mt-4 text-xs text-base-content/70">{{ t('sharing.detail.hiddenNote') }}</p>
            <NfsBlock v-if="data.share.nfs && data.nfs" :share="data.share.name" :path="data.share.placePath"
              :clients="data.share.nfsClients" :write-as="data.nfs.writeAs" :host="connect.host" title="NFS" />
            <SftpBlock v-if="data.share.sftp && data.sftp" :share="data.share.name" :user="currentUsername ?? 'admin'" :port="data.sftp.port"
              :host="connect.host" :left-out="data.sftp.leftOut" title="SFTP" />
          </TabsContent>

          <TabsContent value="access" class="space-y-6">
            <ShareChecks :checks="data.checks" :read-only="data.share.readOnly" />
            <ShareAccess :access="data.access" />
          </TabsContent>

          <TabsContent value="activity" class="space-y-6">
            <ShareSessions v-if="data.share.smb" :sessions="data.sessions" can-disconnect :busy-key="disconnecting"
              :title="data.share.nfs || data.share.sftp ? t('sharing.detail.nowOver', { protocol: 'SMB' }) : undefined" @disconnect="disconnect" />
            <section v-if="data.share.nfs && data.nfs" class="space-y-2">
              <h4 class="text-sm font-semibold text-base-content">{{ t('sharing.detail.nowOver', { protocol: 'NFS' }) }}</h4>
              <p v-if="data.nfs.clients.length === 0" class="text-sm text-base-content/70">{{ t('sharing.detail.nobody') }}</p>
              <ul v-else class="divide-y divide-base-300/70">
                <li v-for="ip in data.nfs.clients" :key="ip" class="flex items-center gap-3 py-2">
                  <MonitorIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
                  <span class="font-mono text-xs text-base-content">{{ ip }}</span>
                  <span class="text-xs text-base-content/70">{{ t('sharing.nfs.mounted') }}</span>
                </li>
              </ul>
            </section>
            <section v-if="data.share.sftp && data.sftp" class="space-y-2">
              <h4 class="text-sm font-semibold text-base-content">{{ t('sharing.detail.nowOver', { protocol: 'SFTP' }) }}</h4>
              <p v-if="data.sftp.sessions.length === 0" class="text-sm text-base-content/70">{{ t('sharing.detail.nobody') }}</p>
              <ul v-else class="divide-y divide-base-300/70">
                <li v-for="u in data.sftp.sessions" :key="u" class="flex items-center gap-3 py-2">
                  <KeyRoundIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
                  <span class="text-sm font-medium text-base-content">{{ u }}</span>
                </li>
              </ul>
            </section>
            <ShareActivity v-if="data.share.smb" :events="data.recent" :sessions="data.sessions" show-user see-all :max-lines="8"
              :title="t('sharing.detail.recentSmb')" @see-all="emit('seeAll', data.share.name)" />
          </TabsContent>
        </div>
      </Tabs>
    </template>
  </div>
</template>
