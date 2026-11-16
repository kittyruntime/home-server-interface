<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize } from '@vueuse/core'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import LoadingState from '../ui/LoadingState.vue'
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
  if (!e) return
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
      <Button v-if="installed && availablePlaces.length > 0" size="sm" @click="openCreate">{{ t('sharing.list.newShare') }}</Button>
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

    <Modal v-if="editor" panel-class="w-full max-w-sm" @close="editor = null">
      <template #header>
        <h3 class="text-sm font-semibold text-base-content">{{ editor.id === null ? t('sharing.detail.newTitle') : t('sharing.detail.editTitle') }}</h3>
      </template>
      <div class="space-y-4 p-6">
        <div v-if="editor.id === null">
          <p class="eyebrow mb-2">{{ t('sharing.detail.place') }}</p>
          <NativeSelect v-model="editor.placeId" wrapper-class="w-full">
            <NativeSelectOption v-for="p in availablePlaces" :key="p.id" :value="p.id">{{ p.name }} · {{ p.path }}</NativeSelectOption>
          </NativeSelect>
        </div>
        <div>
          <p class="eyebrow mb-2">{{ t('sharing.detail.shareName') }}</p>
          <Input v-model="editor.smbName" type="text" :placeholder="t('sharing.detail.shareNamePlaceholder')" class="w-full font-mono" />
          <p class="mt-1 text-xs text-base-content/70">{{ t('sharing.detail.shareNameHelp') }}</p>
        </div>
        <label class="flex cursor-pointer items-center gap-2 text-sm text-base-content/80"><Checkbox v-model="editor.readOnly" />{{ t('sharing.detail.readOnlyOption') }}</label>
        <label class="flex cursor-pointer items-center gap-2 text-sm text-base-content/80"><Checkbox v-model="editor.guestOk" />{{ t('sharing.detail.guestOption') }}</label>
        <label class="flex cursor-pointer items-center gap-2 text-sm text-base-content/80"><Checkbox v-model="editor.hidden" />{{ t('sharing.detail.hiddenOption') }}</label>
        <Alert v-if="editorError" variant="destructive"><AlertDescription>{{ editorError }}</AlertDescription></Alert>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="editor = null">{{ t('sharing.detail.cancel') }}</Button>
          <Button size="sm" :disabled="saving || (editor.id === null && !editor.placeId)" @click="save">
            {{ editor.id === null ? t('sharing.detail.create') : t('sharing.detail.save') }}
          </Button>
        </div>
      </template>
    </Modal>
  </div>
</template>
