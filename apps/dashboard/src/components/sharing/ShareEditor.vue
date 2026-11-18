<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import BusyLabel from '../ui/BusyLabel.vue'
import Modal from '../ui/Modal.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import type { ShareDetailData, SharingService } from '../../lib/sharing-types'

type PlaceRow = { id: string; name: string; path: string }

const props = defineProps<{
  /** The share to edit; null creates one. */
  share: ShareDetailData['share'] | null
  /** Edit: the share's Place. */
  placeId?: string
  placeName?: string
  /** Create: the Places not shared yet. */
  places: PlaceRow[]
  service: SharingService | null
}>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useI18n()

const s = props.share
const e = ref({
  placeId: s ? props.placeId ?? '' : props.places[0]?.id ?? '',
  smbName: s?.smbName ?? '',
  readOnly: s?.readOnly ?? false,
  guestOk: s?.guestOk ?? false,
  hidden: s?.hidden ?? false,
  timeMachine: s?.timeMachine ?? false,
  timeMachineMaxGb: (s?.timeMachineMaxGb ?? '') as number | '',
  smb: s?.smb ?? true,
  nfs: s?.nfs ?? false,
  nfsClients: s?.nfsClients || (props.service?.suggestedNfsClients ?? ''),
  nfsWriteAs: s?.nfsWriteAs ?? '',
  sftp: s?.sftp ?? false,
})

type Tab = 'general' | 'smb' | 'nfs' | 'sftp'
const tab = ref<Tab>('general')

// The name the share gets when the field stays empty.
const placeholderName = computed(() => s ? props.placeName ?? '' : props.places.find(p => p.id === e.value.placeId)?.name ?? '')

// Time Machine needs Samba's fruit modules; a share that already has it can still turn it off.
const timeMachineAvailable = computed(() => props.service?.state?.timeMachine ?? false)
const nfsMissing = computed(() => !(props.service?.nfs?.installed ?? false))
const sftpReason = computed(() => {
  const x = props.service?.sftp
  if (!x?.installed) return t('sharing.sftp.missing')
  return x.supported ? '' : t('sharing.sftp.unsupported')
})

// Who may own new NFS files: the Place's writers and the admins.
const writers = ref<string[]>([])
watch(() => e.value.nfs && e.value.placeId, async placeId => {
  writers.value = []
  if (!placeId) return
  try { writers.value = await trpc.sharing.writers.query({ placeId }) } catch { /* the select keeps "read-only" only */ }
}, { immediate: true })

const noProtocol = computed(() => !e.value.smb && !e.value.nfs && !e.value.sftp)
const nfsIncomplete = computed(() => e.value.nfs && !e.value.nfsClients.trim())
const canSave = computed(() => !noProtocol.value && !nfsIncomplete.value && (!!s || !!e.value.placeId))

const tabs = computed(() => [
  { id: 'general' as const, label: t('sharing.editor.general'), on: false },
  { id: 'smb' as const, label: 'SMB', on: e.value.smb },
  { id: 'nfs' as const, label: 'NFS', on: e.value.nfs },
  { id: 'sftp' as const, label: 'SFTP', on: e.value.sftp },
])

const saving = ref(false)
const error = ref('')

async function save() {
  if (saving.value) return
  if (nfsIncomplete.value) { tab.value = 'nfs'; return }
  if (!canSave.value) return
  const v = e.value
  saving.value = true
  error.value = ''
  const common = {
    readOnly: v.readOnly, guestOk: v.guestOk, hidden: v.hidden,
    timeMachine: v.smb && v.timeMachine, timeMachineMaxGb: v.smb && v.timeMachine && v.timeMachineMaxGb !== '' ? v.timeMachineMaxGb : null,
    smb: v.smb, nfs: v.nfs, nfsClients: v.nfs ? v.nfsClients.trim() : '', nfsWriteAs: v.nfs ? v.nfsWriteAs : '', sftp: v.sftp,
  }
  try {
    if (!s) {
      await applyPlanned('share.create', { placeId: v.placeId, smbName: v.smbName.trim() || undefined, ...common },
        { domain: 'sharing', title: t('sharing.detail.createPlan'), actionLabel: t('sharing.detail.create') })
    } else {
      await applyPlanned('share.update', { id: s.id, smbName: v.smbName.trim() || null, ...common },
        { domain: 'sharing', title: t('sharing.detail.savePlan'), actionLabel: t('sharing.detail.save') })
    }
    emit('saved')
  } catch (err) {
    error.value = (err as Error).message || t('sharing.errors.action')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal panel-class="w-full max-w-xl" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-base-content">{{ s ? t('sharing.editor.editTitle', { name: s.name }) : t('sharing.detail.newTitle') }}</h3>
    </template>
    <form id="share-editor" novalidate @submit.prevent="save">
      <Tabs v-model="tab">
        <div class="border-b border-base-300 px-6 pt-4">
          <TabsList :aria-label="t('sharing.editor.sections')" variant="border">
            <TabsTrigger v-for="x in tabs" :key="x.id" :value="x.id" class="flex-none px-3">
              {{ x.label }}
              <span v-if="x.on" class="size-1.5 rounded-full bg-success" aria-hidden="true" />
              <span v-if="x.on" class="sr-only">{{ t('sharing.editor.on') }}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <div class="min-h-72 p-6">
          <TabsContent value="general" class="space-y-5">
            <label v-if="!s" class="block space-y-1.5">
              <span class="text-sm font-medium text-base-content">{{ t('sharing.detail.place') }}</span>
              <NativeSelect v-model="e.placeId" wrapper-class="w-full">
                <NativeSelectOption v-for="p in places" :key="p.id" :value="p.id">{{ p.name }} · {{ p.path }}</NativeSelectOption>
              </NativeSelect>
            </label>
            <label class="block space-y-1.5">
              <span class="text-sm font-medium text-base-content">{{ t('sharing.detail.shareName') }}</span>
              <Input v-model="e.smbName" type="text" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" autocomplete="off" spellcheck="false"
                :placeholder="placeholderName" class="w-full font-mono" />
              <span class="block text-xs text-base-content/70">{{ t('sharing.detail.shareNameHelp') }}</span>
            </label>
            <label class="flex cursor-pointer items-start justify-between gap-4 border-t border-base-300 pt-5">
              <span class="min-w-0">
                <span class="block text-sm text-base-content">{{ t('sharing.detail.readOnlyOption') }}</span>
                <span class="block text-xs text-base-content/70">{{ t('sharing.detail.readOnlyHelp') }}</span>
              </span>
              <Switch v-model="e.readOnly" class="shrink-0" />
            </label>
            <div class="border-t border-base-300 pt-5">
              <p class="mb-2 text-sm font-medium text-base-content">{{ t('sharing.detail.protocols') }}</p>
              <ul class="flex flex-wrap gap-2">
                <li v-for="x in tabs.slice(1)" :key="x.id">
                  <button type="button" class="badge gap-1.5" :class="x.on ? 'badge-success badge-soft' : 'badge-ghost text-base-content/70'" @click="tab = x.id">
                    {{ x.label }} · {{ x.on ? t('sharing.editor.on') : t('sharing.editor.off') }}
                  </button>
                </li>
              </ul>
            </div>
          </TabsContent>

          <TabsContent value="smb" class="space-y-5">
            <label class="flex cursor-pointer items-start justify-between gap-4">
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-base-content">{{ t('sharing.editor.enableSmb') }}</span>
                <span class="block text-xs text-base-content/70">{{ t('sharing.detail.smbHelp') }}</span>
              </span>
              <Switch v-model="e.smb" class="shrink-0" />
            </label>
            <fieldset :disabled="!e.smb" class="space-y-4 border-t border-base-300 pt-5 disabled:opacity-60">
              <legend class="sr-only">{{ t('sharing.detail.options') }}</legend>
              <label class="flex cursor-pointer items-start gap-3">
                <Checkbox v-model="e.guestOk" class="mt-0.5" :disabled="!e.smb" />
                <span class="min-w-0">
                  <span class="block text-sm text-base-content">{{ t('sharing.detail.guestOkOption') }}</span>
                  <span class="block text-xs text-base-content/70">{{ t('sharing.detail.guestOkHelp') }}</span>
                </span>
              </label>
              <label class="flex cursor-pointer items-start gap-3">
                <Checkbox v-model="e.hidden" class="mt-0.5" :disabled="!e.smb" />
                <span class="min-w-0">
                  <span class="block text-sm text-base-content">{{ t('sharing.detail.hiddenOption') }}</span>
                  <span class="block text-xs text-base-content/70">{{ t('sharing.detail.hiddenHelp') }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3" :class="e.smb && (timeMachineAvailable || e.timeMachine) ? 'cursor-pointer' : 'cursor-not-allowed'">
                <Checkbox v-model="e.timeMachine" class="mt-0.5" :disabled="!e.smb || (!timeMachineAvailable && !e.timeMachine)" />
                <span class="min-w-0">
                  <span class="block text-sm text-base-content">{{ t('sharing.detail.timeMachineOption') }}</span>
                  <span class="block text-xs text-base-content/70">{{ timeMachineAvailable ? t('sharing.detail.timeMachineHelp') : t('sharing.detail.timeMachineUnavailable') }}</span>
                </span>
              </label>
              <label v-if="e.timeMachine" class="block space-y-1.5 pl-7">
                <span class="text-xs font-medium text-base-content/80">{{ t('sharing.detail.timeMachineMax') }}</span>
                <div class="relative max-w-40">
                  <Input v-model.number="e.timeMachineMaxGb" type="number" inputmode="numeric" min="1" step="1" :placeholder="t('sharing.detail.noLimit')"
                    class="w-full pr-10 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                  <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-base-content/60">{{ t('sharing.detail.gb') }}</span>
                </div>
                <span class="block text-xs text-base-content/70">{{ t('sharing.detail.timeMachineMaxHelp') }}</span>
              </label>
            </fieldset>
          </TabsContent>

          <TabsContent value="nfs" class="space-y-5">
            <label class="flex items-start justify-between gap-4" :class="nfsMissing && !e.nfs ? 'cursor-not-allowed' : 'cursor-pointer'">
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-base-content">{{ t('sharing.editor.enableNfs') }}</span>
                <span class="block text-xs text-base-content/70">{{ nfsMissing ? t('sharing.nfs.missing') : t('sharing.detail.nfsHelp') }}</span>
              </span>
              <Switch v-model="e.nfs" class="shrink-0" :disabled="nfsMissing && !e.nfs" />
            </label>
            <fieldset v-if="e.nfs" class="space-y-4 border-t border-base-300 pt-5">
              <legend class="sr-only">{{ t('sharing.detail.options') }}</legend>
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-base-content">{{ t('sharing.nfs.clients') }}</span>
                <Input v-model="e.nfsClients" type="text" autocomplete="off" spellcheck="false" class="w-full font-mono" placeholder="192.168.1.0/24"
                  :aria-invalid="nfsIncomplete || undefined" />
                <span class="block text-xs" :class="nfsIncomplete ? 'text-error' : 'text-base-content/70'">{{ nfsIncomplete ? t('sharing.editor.nfsClientsNeeded') : t('sharing.nfs.clientsHelp') }}</span>
              </label>
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-base-content">{{ t('sharing.nfs.owner') }}</span>
                <NativeSelect v-model="e.nfsWriteAs" wrapper-class="w-full" :disabled="e.readOnly">
                  <NativeSelectOption value="">{{ t('sharing.nfs.nobody') }}</NativeSelectOption>
                  <NativeSelectOption v-for="w in writers" :key="w" :value="w">{{ w }}</NativeSelectOption>
                </NativeSelect>
                <span class="block text-xs text-base-content/70">{{ e.readOnly ? t('sharing.nfs.ownerReadOnly') : t('sharing.nfs.ownerHelp') }}</span>
              </label>
            </fieldset>
          </TabsContent>

          <TabsContent value="sftp" class="space-y-5">
            <label class="flex items-start justify-between gap-4" :class="sftpReason && !e.sftp ? 'cursor-not-allowed' : 'cursor-pointer'">
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-base-content">{{ t('sharing.editor.enableSftp') }}</span>
                <span class="block text-xs text-base-content/70">{{ sftpReason || t('sharing.sftp.help') }}</span>
              </span>
              <Switch v-model="e.sftp" class="shrink-0" :disabled="!!sftpReason && !e.sftp" />
            </label>
            <p v-if="e.sftp" class="border-t border-base-300 pt-5 text-xs text-base-content/70">{{ t('sharing.services.sftpHelp') }}</p>
          </TabsContent>
        </div>
      </Tabs>
      <div v-if="error || noProtocol" class="px-6 pb-4">
        <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
        <p v-else class="text-xs text-warning" role="status">{{ t('sharing.editor.pickOne') }}</p>
      </div>
    </form>
    <template #footer>
      <div class="ml-auto flex gap-2">
        <Button variant="ghost" size="sm" @click="emit('close')">{{ t('sharing.detail.cancel') }}</Button>
        <Button type="submit" form="share-editor" size="sm" :disabled="saving || !canSave && !nfsIncomplete">
          <BusyLabel :busy="saving">{{ s ? t('sharing.detail.save') : t('sharing.detail.create') }}</BusyLabel>
        </Button>
      </div>
    </template>
  </Modal>
</template>
