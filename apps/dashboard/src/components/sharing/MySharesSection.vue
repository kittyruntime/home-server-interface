<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheckIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import LoadingState from '../ui/LoadingState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import ConnectBlock from './ConnectBlock.vue'
import SftpBlock from './SftpBlock.vue'
import ShareSessions from './ShareSessions.vue'
import ShareActivity from './ShareActivity.vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import type { ShareEventRow, ShareSession } from '../../lib/sharing-types'

const { t } = useI18n()
const toast = useToast()

type Mine = Awaited<ReturnType<typeof trpc.sharing.mine.query>>
const mine = ref<Mine | null>(null)
const sessions = ref<ShareSession[]>([])
const events = ref<ShareEventRow[]>([])
const loading = ref(true)
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const [m, s, e] = await Promise.all([
      trpc.sharing.mine.query(), trpc.sharing.sessions.query(), trpc.sharing.events.query({ limit: 40 }),
    ])
    mine.value = m
    sessions.value = s
    events.value = e.items
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message || t('sharing.errors.load')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  timer = setInterval(() => { if (!document.hidden) void load() }, 10000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

const repairing = ref(false)
const password = ref('')
const repairError = ref('')
const busy = ref(false)
const passwordInput = useTemplateRef<{ focus: () => void }>('passwordInput')

async function openRepair() {
  repairing.value = true
  repairError.value = ''
  await nextTick()
  passwordInput.value?.focus()
}
function closeRepair() {
  repairing.value = false
  password.value = ''
  repairError.value = ''
}

async function repair() {
  busy.value = true
  repairError.value = ''
  try {
    const res = await trpc.sharing.repairPassword.mutate({ password: password.value })
    if (res.ok) {
      toast.success(t('sharing.mine.repairDone'))
      repairing.value = false
      await load()
    } else {
      repairError.value = t('sharing.mine.repairFailed')
    }
  } catch (err) {
    const code = (err as { data?: { code?: string } }).data?.code
    repairError.value = code === 'UNAUTHORIZED' ? t('sharing.mine.wrongPassword') : (err as Error).message || t('sharing.mine.repairFailed')
  } finally {
    password.value = ''
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.mine.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.mine.subtitle') }}</p>
    </div>

    <LoadingState v-if="loading" variant="compact" />
    <Alert v-else-if="error && !mine" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <template v-if="mine">
      <Alert v-if="!mine.serviceActive" variant="warning"><AlertDescription>{{ t('sharing.mine.serviceOff') }}</AlertDescription></Alert>

      <Card class="gap-3 p-4 @2xl:p-5">
        <div class="flex items-start gap-3">
          <CircleCheckIcon v-if="mine.networkPassword" class="mt-0.5 size-5 shrink-0 text-success" />
          <TriangleAlertIcon v-else class="mt-0.5 size-5 shrink-0 text-warning" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-base-content">{{ t('sharing.mine.password') }}</p>
            <p class="text-sm text-base-content/80">{{ mine.networkPassword ? t('sharing.mine.passwordOk') : t('sharing.mine.passwordMissing') }}</p>
          </div>
          <Button v-if="!mine.networkPassword && !repairing" size="sm" class="shrink-0" @click="openRepair">{{ t('sharing.mine.repair') }}</Button>
        </div>
        <form v-if="repairing" class="space-y-2 @md:pl-8" @submit.prevent="repair">
          <label for="repair-password" class="block text-xs text-base-content/80">{{ t('sharing.mine.repairHelp') }}</label>
          <div class="flex flex-wrap gap-2">
            <Input id="repair-password" ref="passwordInput" v-model="password" type="password" autocomplete="current-password"
              :placeholder="t('sharing.mine.repairPassword')" :aria-invalid="!!repairError || undefined" class="min-w-0 flex-1 basis-48"
              @keydown.esc="closeRepair" />
            <div class="flex gap-2">
              <Button type="button" variant="ghost" size="sm" :disabled="busy" @click="closeRepair">{{ t('sharing.detail.cancel') }}</Button>
              <Button type="submit" size="sm" :disabled="!password || busy">
                <BusyLabel :busy="busy">{{ t('sharing.mine.repair') }}</BusyLabel>
              </Button>
            </div>
          </div>
          <p v-if="repairError" class="text-xs text-error" role="alert">{{ repairError }}</p>
        </form>
      </Card>

      <Card v-if="mine.shares.length === 0" class="p-6 text-sm text-base-content/70">{{ t('sharing.mine.empty') }}</Card>
      <Card v-for="s in mine.shares" :key="s.id" class="gap-4 p-4 @2xl:p-5">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-base font-semibold text-base-content">{{ s.name }}</h3>
          <Badge variant="secondary">{{ s.level === 'write' ? t('sharing.list.readWrite') : t('sharing.list.readOnly') }}</Badge>
          <Badge v-if="s.guestOk" variant="outline">{{ t('sharing.list.guest') }}</Badge>
        </div>
        <ConnectBlock v-if="s.smb" :share="s.name" :guest-ok="s.guestOk" :username="mine.username" :netbios-name="mine.netbiosName" :wsd="mine.discovery.wsd" :mdns="mine.discovery.mdns" :host="mine.lanAddress || undefined"
          :title="s.sftp && mine.sftp?.usable ? t('sharing.detail.connectSmb') : undefined" />
        <SftpBlock v-if="s.sftp && mine.sftp?.usable" :share="s.name" :user="mine.username" :port="mine.sftp.port" :host="mine.lanAddress || undefined" />
      </Card>

      <Card class="gap-6 p-4 @2xl:p-5">
        <ShareSessions :sessions="sessions" :title="t('sharing.mine.yourSessions')" />
        <ShareActivity :events="events" :sessions="sessions" :title="t('sharing.mine.yourActivity')" :max-lines="8" />
      </Card>
    </template>
  </div>
</template>
