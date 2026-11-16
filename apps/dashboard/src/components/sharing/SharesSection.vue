<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue'
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
const editor = ref<{ id: string | null; placeId: string; smbName: string; readOnly: boolean; guestOk: boolean; hidden: boolean } | null>(null)
const saving = ref(false)
const OPTIONS = ['readOnly', 'guestOk', 'hidden'] as const
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
  editor.value = { id: null, placeId: availablePlaces.value[0]?.id ?? '', smbName: '', readOnly: false, guestOk: false, hidden: false }
}

function openEdit(s: ShareDetailData['share']) {
  editorError.value = ''
  editor.value = { id: s.id, placeId: '', smbName: s.smbName ?? '', readOnly: s.readOnly, guestOk: s.guestOk, hidden: s.hidden }
}

async function save() {
  const e = editor.value
  if (!e || saving.value) return
  saving.value = true
  editorError.value = ''
  try {
    if (e.id === null) {
      await applyPlanned('share.create', {
        placeId: e.placeId, smbName: e.smbName.trim() || undefined, readOnly: e.readOnly, guestOk: e.guestOk, hidden: e.hidden,
      }, { domain: 'sharing', title: t('sharing.detail.createPlan'), actionLabel: t('sharing.detail.create') })
    } else {
      await applyPlanned('share.update', {
        id: e.id, smbName: e.smbName.trim() || null, readOnly: e.readOnly, guestOk: e.guestOk, hidden: e.hidden,
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

    <Modal v-if="editor" panel-class="w-full max-w-md" @close="editor = null">
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
        <fieldset class="space-y-3">
          <legend class="sr-only">{{ t('sharing.detail.options') }}</legend>
          <label v-for="o in OPTIONS" :key="o" class="flex cursor-pointer items-start gap-3">
            <Checkbox v-model="editor[o]" class="mt-0.5" />
            <span class="min-w-0">
              <span class="block text-sm text-base-content">{{ t(`sharing.detail.${o}Option`) }}</span>
              <span class="block text-xs text-base-content/70">{{ t(`sharing.detail.${o}Help`) }}</span>
            </span>
          </label>
        </fieldset>
        <Alert v-if="editorError" variant="destructive"><AlertDescription>{{ editorError }}</AlertDescription></Alert>
      </form>
      <template #footer>
        <div class="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" @click="editor = null">{{ t('sharing.detail.cancel') }}</Button>
          <Button type="submit" form="share-editor" size="sm" :disabled="saving || (editor.id === null && !editor.placeId)">
            <BusyLabel :busy="saving">{{ editor.id === null ? t('sharing.detail.create') : t('sharing.detail.save') }}</BusyLabel>
          </Button>
        </div>
      </template>
    </Modal>
  </div>
</template>
