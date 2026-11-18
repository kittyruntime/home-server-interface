<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { AppleIcon, FolderSyncIcon, KeyRoundIcon, NetworkIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import BusyLabel from '../ui/BusyLabel.vue'
import ServiceCard, { type ServiceState } from './ServiceCard.vue'
import SaveBar from './SaveBar.vue'
import { trpc } from '../../lib/trpc'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { SMB_FIELDS, useSmbSettingsForm } from '../../lib/smb-settings-form'
import type { SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null; loading: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const { confirm } = useConfirm()
const toast = useToast()

// ── SMB ─────────────────────────────────────────────────────────────────────

const smbState = computed<ServiceState | 'unknown'>(() => {
  const s = props.service?.state
  if (!s) return props.loading ? 'checking' : 'unknown'
  if (!s.installed) return 'missing'
  return s.active ? 'on' : 'off'
})
const smbLabel = computed(() => ({
  on: t('sharing.services.running'), off: t('sharing.services.stopped'), missing: t('sharing.services.notInstalled'),
  checking: t('sharing.services.checking'), unknown: t('sharing.services.notAnswering'),
})[smbState.value])

const acting = ref(false)
async function act(action: 'start' | 'restart') {
  if (action === 'restart' && !await confirm(t('sharing.banner.restartConfirm'), { confirmLabel: t('sharing.banner.restart') })) return
  acting.value = true
  try {
    await trpc.sharing.serviceAction.mutate({ action })
    toast.success(t('sharing.banner.done'))
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  } finally {
    acting.value = false
    emit('changed')
  }
}

const { form, dirty, invalid, hasInvalid, saving, error, reset, save } = useSmbSettingsForm(
  toRef(props, 'service'), SMB_FIELDS, { title: t('sharing.settings.savePlan'), action: t('sharing.settings.save'), failed: t('sharing.errors.action') })

async function submit() {
  if (await save()) {
    toast.success(t('sharing.settings.saved'))
    emit('changed')
  }
}

const wsdMissing = computed(() => !props.service?.state?.wsdd)
const mdnsMissing = computed(() => !props.service?.state?.avahi)
// A switch for a tool the server lacks stays off, unless it is on and can be turned off.
const discovery = computed(() => [
  { field: 'discoveryWsd' as const, label: t('sharing.settings.wsd'), missing: wsdMissing.value,
    help: wsdMissing.value ? t('sharing.settings.wsdMissing') : t('sharing.settings.wsdHelp') },
  { field: 'discoveryMdns' as const, label: t('sharing.settings.mdns'), missing: mdnsMissing.value,
    help: mdnsMissing.value ? t('sharing.settings.mdnsMissing') : t('sharing.settings.mdnsHelp') },
].map(d => ({ ...d, locked: d.missing && !form.value?.[d.field] })))

// ── The others ──────────────────────────────────────────────────────────────

const tmState = computed<ServiceState>(() => {
  if (!props.service) return props.loading ? 'checking' : 'missing'
  return props.service.state?.timeMachine ? 'on' : 'missing'
})
const nfsState = computed<ServiceState>(() => {
  const n = props.service?.nfs
  if (!n) return props.loading ? 'checking' : 'missing'
  if (!n.installed) return 'missing'
  return n.active ? 'on' : 'off'
})
const sftpState = computed<ServiceState>(() => {
  const s = props.service?.sftp
  if (!s) return props.loading ? 'checking' : 'missing'
  if (!s.installed || !s.supported) return 'missing'
  return s.active ? 'on' : 'off'
})
const sftpLabel = computed(() => {
  const s = props.service?.sftp
  if (sftpState.value === 'checking') return t('sharing.services.checking')
  if (!s?.installed) return t('sharing.services.notInstalled')
  if (!s.supported) return t('sharing.services.notSupported')
  return s.active ? t('sharing.services.runningPort', { port: s.port }) : t('sharing.services.stopped')
})
const plainLabel = (s: ServiceState) => ({
  on: t('sharing.services.running'), off: t('sharing.services.stopped'), missing: t('sharing.services.notInstalled'), checking: t('sharing.services.checking'),
})[s]
</script>

<template>
  <section class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.services.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.services.subtitle') }}</p>
    </div>

    <form novalidate class="space-y-4" @submit.prevent="submit">
      <ServiceCard :icon="NetworkIcon" title="SMB" :summary="t('sharing.services.smbSummary')"
        :state="smbState === 'unknown' ? 'missing' : smbState" :state-label="smbLabel">
        <template #actions>
          <Button v-if="smbState === 'off'" type="button" size="sm" :disabled="acting" @click="act('start')">
            <BusyLabel :busy="acting">{{ t('sharing.banner.start') }}</BusyLabel>
          </Button>
          <Button v-else-if="smbState === 'on'" type="button" variant="outline" size="sm" :disabled="acting" @click="act('restart')">
            <BusyLabel :busy="acting">{{ t('sharing.banner.restart') }}</BusyLabel>
          </Button>
        </template>

        <div v-if="smbState === 'missing' || smbState === 'unknown'" class="space-y-2">
          <p class="text-sm text-base-content/80">{{ smbState === 'missing' ? t('sharing.banner.missingHelp') : t('sharing.banner.unknown') }}</p>
          <a v-if="smbState === 'missing'" class="link link-primary text-sm" href="https://kittyruntime.github.io/home-server-interface/guide/features/users-shares/" target="_blank" rel="noopener">{{ t('sharing.banner.docs') }}</a>
        </div>

        <template v-if="form && smbState !== 'missing'">
          <p v-if="smbState === 'on'" class="text-sm text-base-content/80">
            <span v-if="service?.settings.netbiosName">{{ t('sharing.banner.announcedAs', { name: service.settings.netbiosName }) }} · </span>
            <span class="tabular-nums">{{ t('sharing.banner.connected', { n: service?.connectedCount ?? 0 }, service?.connectedCount ?? 0) }}</span>
          </p>

          <fieldset class="space-y-3">
            <legend class="mb-3 text-sm font-semibold text-base-content">{{ t('sharing.settings.network') }}</legend>
            <div class="grid gap-4 @xl:grid-cols-2">
              <label v-for="f in (['netbiosName', 'workgroup'] as const)" :key="f" class="block space-y-1.5">
                <span class="text-sm font-medium text-base-content">{{ t(`sharing.settings.${f}`) }}</span>
                <Input v-model="form[f]" maxlength="15" autocomplete="off" spellcheck="false" class="w-full font-mono"
                  :placeholder="f === 'workgroup' ? 'WORKGROUP' : undefined" :aria-invalid="invalid[f] || undefined" />
                <span class="block text-xs" :class="invalid[f] ? 'text-error' : 'text-base-content/70'">
                  {{ invalid[f] ? t('sharing.settings.nameInvalid') : t(`sharing.settings.${f === 'netbiosName' ? 'netbiosHelp' : 'workgroupHelp'}`) }}
                </span>
              </label>
            </div>
          </fieldset>

          <fieldset class="border-t border-base-300 pt-5">
            <legend class="sr-only">{{ t('sharing.settings.discovery') }}</legend>
            <p class="mb-1 text-sm font-semibold text-base-content" aria-hidden="true">{{ t('sharing.settings.discovery') }}</p>
            <ul class="divide-y divide-base-300/70">
              <li v-for="d in discovery" :key="d.field" class="py-3 last:pb-0">
                <label class="flex items-center justify-between gap-4" :class="d.locked ? 'cursor-default' : 'cursor-pointer'">
                  <span class="min-w-0">
                    <span class="block text-sm text-base-content">{{ d.label }}</span>
                    <span class="block text-xs text-base-content/70">{{ d.help }}</span>
                  </span>
                  <span v-if="d.locked" class="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">{{ t('sharing.settings.notInstalled') }}</span>
                  <Switch v-else v-model="form[d.field]" class="shrink-0" />
                </label>
              </li>
            </ul>
          </fieldset>

          <fieldset class="border-t border-base-300 pt-5">
            <legend class="sr-only">{{ t('sharing.services.protocol') }}</legend>
            <p class="mb-3 text-sm font-semibold text-base-content" aria-hidden="true">{{ t('sharing.services.protocol') }}</p>
            <div class="grid gap-4 @xl:grid-cols-2">
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-base-content">{{ t('sharing.settings.minProtocol') }}</span>
                <NativeSelect v-model="form.minProtocol" wrapper-class="w-full">
                  <NativeSelectOption value="SMB2">{{ t('sharing.settings.smb2') }}</NativeSelectOption>
                  <NativeSelectOption value="SMB3">{{ t('sharing.settings.smb3') }}</NativeSelectOption>
                </NativeSelect>
                <span class="block text-xs text-base-content/70">{{ t('sharing.settings.minProtocolHelp') }}</span>
              </label>
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-base-content">{{ t('sharing.settings.encryption') }}</span>
                <NativeSelect v-model="form.encryption" wrapper-class="w-full">
                  <NativeSelectOption value="off">{{ t('sharing.settings.encOff') }}</NativeSelectOption>
                  <NativeSelectOption value="desired">{{ t('sharing.settings.encDesired') }}</NativeSelectOption>
                  <NativeSelectOption value="required">{{ t('sharing.settings.encRequired') }}</NativeSelectOption>
                </NativeSelect>
                <span class="block text-xs text-base-content/70">{{ t('sharing.settings.encryptionHelp') }}</span>
              </label>
            </div>
          </fieldset>

          <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
        </template>
      </ServiceCard>

      <SaveBar v-if="dirty" :saving="saving" :invalid="hasInvalid" @reset="reset" />
    </form>

    <ServiceCard :icon="AppleIcon" :title="t('sharing.services.tmTitle')" :summary="t('sharing.services.tmSummary')"
      :state="tmState" :state-label="tmState === 'on' ? t('sharing.services.available') : tmState === 'checking' ? t('sharing.services.checking') : t('sharing.services.unavailable')">
      <p class="text-sm text-base-content/80">{{ tmState === 'on' ? t('sharing.services.tmHelp') : t('sharing.detail.timeMachineUnavailable') }}</p>
    </ServiceCard>

    <ServiceCard :icon="FolderSyncIcon" title="NFS" :summary="t('sharing.services.nfsSummary')" :state="nfsState" :state-label="plainLabel(nfsState)">
      <p class="text-sm text-base-content/80">{{ service?.nfs?.installed ? t('sharing.services.nfsHelp') : t('sharing.nfs.missing') }}</p>
    </ServiceCard>

    <ServiceCard :icon="KeyRoundIcon" title="SFTP" :summary="t('sharing.services.sftpSummary')" :state="sftpState" :state-label="sftpLabel">
      <p class="text-sm text-base-content/80">
        {{ !service?.sftp || service.sftp.supported ? t('sharing.services.sftpHelp') : !service.sftp.installed ? t('sharing.sftp.missing') : t('sharing.sftp.unsupported') }}
      </p>
    </ServiceCard>
  </section>
</template>
