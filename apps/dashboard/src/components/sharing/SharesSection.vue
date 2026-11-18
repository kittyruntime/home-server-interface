<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize } from '@vueuse/core'
import { PlusIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import LoadingState from '../ui/LoadingState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import Modal from '../ui/Modal.vue'
import ShareList from './ShareList.vue'
import ShareDetail from './ShareDetail.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useVolumeHolds } from '../../lib/volumes'
import { connectInfo, type ShareDetailData, type ShareListRow, type SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null }>()
const emit = defineEmits<{ seeAll: [share: string]; changed: [] }>()

const { t } = useI18n()

type PlaceRow = { id: string; name: string; path: string }

const shares = ref<ShareListRow[]>([])
const places = ref<PlaceRow[]>([])
const loading = ref(true)
const error = ref('')
const selectedId = ref<string | null>(null)

const root = useTemplateRef<HTMLElement>('root')
const { width } = useElementSize(root)
// Below 48rem the list fills the space and the detail opens over it.
const narrow = computed(() => width.value > 0 && width.value < 768)

const installed = computed(() => props.service?.state?.installed ?? false)
const connect = computed(() => connectInfo(props.service))

const availablePlaces = computed(() => {
  const shared = new Set(shares.value.map(s => s.placeId))
  return places.value.filter(p => !shared.has(p.id))
})

const { holdForPath, refreshHolds } = useVolumeHolds()
const unavailable = (path: string) => holdForPath(path) !== undefined

async function refresh() {
  try {
    const [s, pl] = await Promise.all([trpc.sharing.list.query(), trpc.place.list.query()])
    shares.value = s
    places.value = pl as PlaceRow[]
    error.value = ''
    if (selectedId.value && !s.some(x => x.id === selectedId.value)) selectedId.value = null
    if (!selectedId.value && !narrow.value) selectedId.value = s[0]?.id ?? null
  } catch (e) {
    error.value = (e as Error).message || t('sharing.errors.load')
  } finally {
    loading.value = false
  }
}

onMounted(() => { void refresh(); void refreshHolds() })

// null = closed; id null = create
type Editor = {
  id: string | null; placeId: string; smbName: string; readOnly: boolean; guestOk: boolean; hidden: boolean
  timeMachine: boolean; timeMachineMaxGb: number | ''
  smb: boolean; nfs: boolean; nfsClients: string; nfsWriteAs: string
}
const editor = ref<Editor | null>(null)
// Time Machine needs Samba's fruit modules; a share that already has it can still turn it off.
const timeMachineAvailable = computed(() => props.service?.state?.timeMachine ?? false)
const saving = ref(false)
const SMB_OPTIONS = ['guestOk', 'hidden'] as const
// The name the share gets when the field stays empty.
const placeholderName = computed(() => {
  const e = editor.value
  if (!e) return ''
  if (e.id !== null) return shares.value.find(s => s.id === e.id)?.placeName ?? ''
  return places.value.find(p => p.id === e.placeId)?.name ?? ''
})
const editorError = ref('')

function openCreate() {
  editorError.value = ''
  editor.value = {
    id: null, placeId: availablePlaces.value[0]?.id ?? '', smbName: '', readOnly: false, guestOk: false, hidden: false,
    timeMachine: false, timeMachineMaxGb: '', smb: true, nfs: false, nfsClients: props.service?.suggestedNfsClients ?? '', nfsWriteAs: '',
  }
}

function openEdit(s: ShareDetailData['share']) {
  editorError.value = ''
  editor.value = {
    id: s.id, placeId: shares.value.find(x => x.id === s.id)?.placeId ?? '', smbName: s.smbName ?? '', readOnly: s.readOnly, guestOk: s.guestOk, hidden: s.hidden,
    timeMachine: s.timeMachine, timeMachineMaxGb: s.timeMachineMaxGb ?? '',
    smb: s.smb, nfs: s.nfs, nfsClients: s.nfsClients || (props.service?.suggestedNfsClients ?? ''), nfsWriteAs: s.nfsWriteAs,
  }
}

// Who may own new NFS files: the place's writers and the admins.
const writers = ref<string[]>([])
watch(() => editor.value?.nfs && editor.value.placeId, async placeId => {
  writers.value = []
  if (!placeId) return
  try { writers.value = await trpc.sharing.writers.query({ placeId }) } catch { /* the select keeps "read-only" only */ }
}, { immediate: true })
const nfsMissing = computed(() => !(props.service?.nfs?.installed ?? false))
const canSave = computed(() => {
  const e = editor.value
  return !!e && (e.smb || e.nfs) && (e.id !== null || !!e.placeId) && (!e.nfs || !!e.nfsClients.trim())
})

async function save() {
  const e = editor.value
  if (!e || saving.value) return
  saving.value = true
  editorError.value = ''
  const timeMachine = {
    timeMachine: e.smb && e.timeMachine, timeMachineMaxGb: e.timeMachine && e.timeMachineMaxGb !== '' ? e.timeMachineMaxGb : null,
    smb: e.smb, nfs: e.nfs, nfsClients: e.nfs ? e.nfsClients.trim() : '', nfsWriteAs: e.nfs ? e.nfsWriteAs : '',
  }
  try {
    if (e.id === null) {
      await applyPlanned('share.create', {
        placeId: e.placeId, smbName: e.smbName.trim() || undefined, readOnly: e.readOnly, guestOk: e.guestOk, hidden: e.hidden, ...timeMachine,
      }, { domain: 'sharing', title: t('sharing.detail.createPlan'), actionLabel: t('sharing.detail.create') })
    } else {
      await applyPlanned('share.update', {
        id: e.id, smbName: e.smbName.trim() || null, readOnly: e.readOnly, guestOk: e.guestOk, hidden: e.hidden, ...timeMachine,
      }, { domain: 'sharing', title: t('sharing.detail.savePlan'), actionLabel: t('sharing.detail.save') })
    }
    editor.value = null
    await refresh()
    emit('changed')
  } catch (err) {
    editorError.value = (err as Error).message || t('sharing.errors.action')
  } finally {
    saving.value = false
  }
}

async function onRemoved() {
  selectedId.value = null
  await refresh()
  emit('changed')
}
</script>

<template>
  <div ref="root" class="@container">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.list.title') }}</h2>
      <Button v-if="installed && !loading" size="sm" :disabled="availablePlaces.length === 0"
        :title="availablePlaces.length === 0 ? t('sharing.list.allShared') : undefined" @click="openCreate">
        <PlusIcon class="size-4" />{{ t('sharing.list.newShare') }}
      </Button>
    </div>

    <Alert v-if="error" variant="destructive" class="mb-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <LoadingState v-if="loading" variant="compact" />

    <Card v-else-if="shares.length === 0" class="p-6 text-sm text-base-content/70">{{ t('sharing.list.empty') }}</Card>

    <Card v-else class="gap-0 overflow-hidden py-0 @3xl:grid @3xl:grid-cols-[17rem_1fr]">
      <ShareList
        v-if="!narrow || !selectedId"
        class="@3xl:border-r @3xl:border-base-300"
        :shares="shares" :selected-id="selectedId" :unavailable="unavailable"
        @select="id => selectedId = id"
      />
      <ShareDetail
        v-if="selectedId"
        :id="selectedId" :connect="connect" :narrow="narrow"
        @back="selectedId = null"
        @edit="openEdit"
        @changed="refresh(); emit('changed')"
        @removed="onRemoved"
        @see-all="name => emit('seeAll', name)"
      />
      <p v-else-if="!narrow" class="p-6 text-sm text-base-content/70">{{ t('sharing.detail.select') }}</p>
    </Card>

    <Modal v-if="editor" panel-class="w-full max-w-lg" @close="editor = null">
      <template #header>
        <h3 class="text-sm font-semibold text-base-content">{{ editor.id === null ? t('sharing.detail.newTitle') : t('sharing.detail.editTitle') }}</h3>
      </template>
      <form id="share-editor" class="space-y-5 p-6" @submit.prevent="save">
        <label v-if="editor.id === null" class="block space-y-1.5">
          <span class="text-sm font-medium text-base-content">{{ t('sharing.detail.place') }}</span>
          <NativeSelect v-model="editor.placeId" wrapper-class="w-full">
            <NativeSelectOption v-for="p in availablePlaces" :key="p.id" :value="p.id">{{ p.name }} · {{ p.path }}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label class="block space-y-1.5">
          <span class="text-sm font-medium text-base-content">{{ t('sharing.detail.shareName') }}</span>
          <Input v-model="editor.smbName" type="text" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" autocomplete="off" spellcheck="false"
            :placeholder="placeholderName" class="w-full font-mono" />
          <span class="block text-xs text-base-content/70">{{ t('sharing.detail.shareNameHelp') }}</span>
        </label>
        <label class="flex cursor-pointer items-start gap-3">
          <Checkbox v-model="editor.readOnly" class="mt-0.5" />
          <span class="min-w-0">
            <span class="block text-sm text-base-content">{{ t('sharing.detail.readOnlyOption') }}</span>
            <span class="block text-xs text-base-content/70">{{ t('sharing.detail.readOnlyHelp') }}</span>
          </span>
        </label>

        <fieldset class="space-y-2">
          <legend class="mb-2 text-sm font-medium text-base-content">{{ t('sharing.detail.protocols') }}</legend>
          <div class="rounded-box border border-base-300" :class="editor.smb && 'border-primary/40'">
            <label class="flex cursor-pointer items-start gap-3 p-3">
              <Checkbox v-model="editor.smb" class="mt-0.5" />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-base-content">SMB</span>
                <span class="block text-xs text-base-content/70">{{ t('sharing.detail.smbHelp') }}</span>
              </span>
            </label>
            <div v-if="editor.smb" class="space-y-3 border-t border-base-300 p-3 pl-10">
              <label v-for="o in SMB_OPTIONS" :key="o" class="flex cursor-pointer items-start gap-3">
                <Checkbox v-model="editor[o]" class="mt-0.5" />
                <span class="min-w-0">
                  <span class="block text-sm text-base-content">{{ t(`sharing.detail.${o}Option`) }}</span>
                  <span class="block text-xs text-base-content/70">{{ t(`sharing.detail.${o}Help`) }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3" :class="timeMachineAvailable || editor.timeMachine ? 'cursor-pointer' : 'cursor-not-allowed'">
                <Checkbox v-model="editor.timeMachine" class="mt-0.5" :disabled="!timeMachineAvailable && !editor.timeMachine" />
                <span class="min-w-0">
                  <span class="block text-sm text-base-content" :class="!timeMachineAvailable && !editor.timeMachine && 'text-base-content/60'">{{ t('sharing.detail.timeMachineOption') }}</span>
                  <span class="block text-xs text-base-content/70">{{ timeMachineAvailable ? t('sharing.detail.timeMachineHelp') : t('sharing.detail.timeMachineUnavailable') }}</span>
                </span>
              </label>
              <label v-if="editor.timeMachine" class="block space-y-1.5 pl-7">
                <span class="text-xs font-medium text-base-content/80">{{ t('sharing.detail.timeMachineMax') }}</span>
                <div class="relative max-w-40">
                  <Input v-model.number="editor.timeMachineMaxGb" type="number" inputmode="numeric" min="1" step="1" :placeholder="t('sharing.detail.noLimit')"
                    class="w-full pr-10 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                  <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-base-content/60">{{ t('sharing.detail.gb') }}</span>
                </div>
                <span class="block text-xs text-base-content/70">{{ t('sharing.detail.timeMachineMaxHelp') }}</span>
              </label>
            </div>
          </div>

          <div class="rounded-box border border-base-300" :class="editor.nfs && 'border-primary/40'">
            <label class="flex items-start gap-3 p-3" :class="nfsMissing && !editor.nfs ? 'cursor-not-allowed' : 'cursor-pointer'">
              <Checkbox v-model="editor.nfs" class="mt-0.5" :disabled="nfsMissing && !editor.nfs" />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-base-content" :class="nfsMissing && !editor.nfs && 'text-base-content/60'">NFS</span>
                <span class="block text-xs text-base-content/70">{{ nfsMissing ? t('sharing.nfs.missing') : t('sharing.detail.nfsHelp') }}</span>
              </span>
            </label>
            <div v-if="editor.nfs" class="space-y-3 border-t border-base-300 p-3 pl-10">
              <label class="block space-y-1.5">
                <span class="text-xs font-medium text-base-content/80">{{ t('sharing.nfs.clients') }}</span>
                <Input v-model="editor.nfsClients" type="text" autocomplete="off" spellcheck="false" class="w-full font-mono" placeholder="192.168.1.0/24" required />
                <span class="block text-xs text-base-content/70">{{ t('sharing.nfs.clientsHelp') }}</span>
              </label>
              <label class="block space-y-1.5">
                <span class="text-xs font-medium text-base-content/80">{{ t('sharing.nfs.owner') }}</span>
                <NativeSelect v-model="editor.nfsWriteAs" wrapper-class="w-full" :disabled="editor.readOnly">
                  <NativeSelectOption value="">{{ t('sharing.nfs.nobody') }}</NativeSelectOption>
                  <NativeSelectOption v-for="w in writers" :key="w" :value="w">{{ w }}</NativeSelectOption>
                </NativeSelect>
                <span class="block text-xs text-base-content/70">{{ editor.readOnly ? t('sharing.nfs.ownerReadOnly') : t('sharing.nfs.ownerHelp') }}</span>
              </label>
            </div>
          </div>
        </fieldset>
        <Alert v-if="editorError" variant="destructive"><AlertDescription>{{ editorError }}</AlertDescription></Alert>
      </form>
      <template #footer>
        <div class="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" @click="editor = null">{{ t('sharing.detail.cancel') }}</Button>
          <Button type="submit" form="share-editor" size="sm" :disabled="saving || !canSave">
            <BusyLabel :busy="saving">{{ editor.id === null ? t('sharing.detail.create') : t('sharing.detail.save') }}</BusyLabel>
          </Button>
        </div>
      </template>
    </Modal>
  </div>
</template>
