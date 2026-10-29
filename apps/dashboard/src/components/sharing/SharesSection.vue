<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import Tip from '../ui/Tip.vue'
import { Checkbox } from '@/components/ui/checkbox'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useVolumeHolds, holdLabel } from '../../lib/volumes'
import Modal from '../ui/Modal.vue'
import { applyPlanned } from '../../lib/plan'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()


type ShareRow = {
  id: string
  placeId: string
  placeName: string
  placePath: string
  enabled: boolean
  readOnly: boolean
  guestOk: boolean
  smbName: string | null
  effectiveName: string
  userCount: number
  excludedUsernames: string[]
}

type PlaceRow = { id: string; name: string; path: string }

const prereq  = ref<{ smbdInstalled: boolean } | null>(null)
const shares  = ref<ShareRow[]>([])
const places  = ref<PlaceRow[]>([])
const loading = ref(true)
const error   = ref('')

// null = closed; { id: null } = create; { id: string } = edit
const editor = ref<{
  id: string | null
  placeId: string
  smbName: string
  readOnly: boolean
  guestOk: boolean
} | null>(null)
const saving      = ref(false)
const editorError = ref('')
const deleting    = ref<string | null>(null)

const availablePlaces = computed(() => {
  const sharedIds = new Set(shares.value.map(s => s.placeId))
  return places.value.filter(p => !sharedIds.has(p.id))
})

async function refresh() {
  error.value = ''
  try {
    const [p, s, pl] = await Promise.all([
      trpc.sharing.checkPrereqs.query(),
      trpc.sharing.list.query(),
      trpc.place.list.query(),
    ])
    prereq.value = p
    shares.value = s
    places.value = pl as PlaceRow[]
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load shares'
  } finally {
    loading.value = false
  }
}

const { holdForPath, refreshHolds } = useVolumeHolds()

onMounted(() => {
  void refresh()
  void refreshHolds()
})

function openCreate() {
  editorError.value = ''
  editor.value = {
    id: null,
    placeId: availablePlaces.value[0]?.id ?? '',
    smbName: '',
    readOnly: false,
    guestOk: false,
  }
}

function openEdit(s: ShareRow) {
  editorError.value = ''
  editor.value = {
    id: s.id,
    placeId: s.placeId,
    smbName: s.smbName ?? '',
    readOnly: s.readOnly,
    guestOk: s.guestOk,
  }
}

async function save() {
  if (!editor.value) return
  saving.value = true
  editorError.value = ''
  try {
    if (editor.value.id === null) {
      await applyPlanned('share.create', {
        placeId: editor.value.placeId,
        smbName: editor.value.smbName.trim() || undefined,
        readOnly: editor.value.readOnly,
        guestOk: editor.value.guestOk,
      }, { domain: 'sharing', title: 'Create the share', actionLabel: 'Share' })
    } else {
      await applyPlanned('share.update', {
        id: editor.value.id,
        smbName: editor.value.smbName.trim() || null,
        readOnly: editor.value.readOnly,
        guestOk: editor.value.guestOk,
      }, { domain: 'sharing', title: 'Save the share', actionLabel: 'Save' })
    }
    editor.value = null
    await refresh()
  } catch (e: unknown) {
    editorError.value = (e as { message?: string })?.message ?? 'Failed to save share'
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(s: ShareRow) {
  error.value = ''
  try {
    await applyPlanned('share.update', { id: s.id, enabled: !s.enabled }, {
      domain: 'sharing',
      title: `${s.enabled ? 'Disable' : 'Enable'} the share ${s.effectiveName}`,
      actionLabel: s.enabled ? 'Disable' : 'Enable',
      danger: s.enabled,
    })
    await refresh()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to update share'
  }
}

async function removeShare(s: ShareRow) {
  deleting.value = s.id
  error.value = ''
  try {
    await applyPlanned('share.remove', { id: s.id }, {
      domain: 'sharing', title: `Stop sharing ${s.effectiveName}; clients lose access`, actionLabel: 'Stop sharing', danger: true,
    })
    await refresh()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to delete share'
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <p class="eyebrow mb-1">{{ t('ui.sharing.SharesSection.networkSharing') }}</p>
        <h2 class="text-lg font-semibold text-foreground">{{ t('ui.sharing.SharesSection.smbShares') }}</h2>
      </div>
      <Button size="sm"
        v-if="prereq?.smbdInstalled && availablePlaces.length > 0"
        @click="openCreate"
      >
        {{ t('ui.sharing.SharesSection.newShare') }}
      </Button>
    </div>

    <p v-if="error" class="status-text text-destructive mb-4">[ERR] {{ error }}</p>

    <LoadingState v-if="loading" variant="compact" />

    <!-- Samba missing: guide, never a cryptic error -->
    <Card v-else-if="prereq && !prereq.smbdInstalled" class="block gap-0 py-0 overflow-hidden p-6">
      <h3 class="text-sm font-semibold text-foreground mb-2">{{ t('ui.sharing.SharesSection.sambaIsNotInstalled') }}</h3>
      <p class="text-sm text-foreground/80 mb-4">
        {{ t('ui.sharing.SharesSection.smbSharingNeedsTheSamba') }}
      </p>
      <code class="inline-block px-3 py-2 rounded-lg bg-muted border border-input text-sm font-mono text-foreground">
        sudo apt install samba
      </code>
      <div class="mt-4">
        <Button variant="outline" size="sm" @click="refresh">{{ t('ui.sharing.SharesSection.checkAgain') }}</Button>
      </div>
    </Card>

    <Card v-else-if="shares.length === 0" class="block gap-0 py-0 overflow-hidden p-6 text-sm text-muted-foreground">
      {{ t('ui.sharing.SharesSection.noSharesYetShareAn') }}
    </Card>

    <div v-else class="space-y-3">
      <Card v-for="s in shares" :key="s.id" class="block gap-0 py-0 overflow-hidden p-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-foreground">{{ s.effectiveName }}</span>
              <Badge :variant="s.enabled ? 'default' : 'secondary'">
                {{ s.enabled ? 'Active' : 'Disabled' }}
              </Badge>
              <Badge variant="secondary" v-if="s.readOnly">{{ t('ui.sharing.SharesSection.readOnly') }}</Badge>
              <Badge variant="secondary" v-if="s.guestOk">{{ t('ui.sharing.SharesSection.guest') }}</Badge>
              <Tip v-if="holdForPath(s.placePath)" :text="holdLabel(holdForPath(s.placePath)!)"><Badge variant="outline" class="bg-destructive/10 text-destructive">{{ t('ui.sharing.SharesSection.unavailable') }}</Badge></Tip>
            </div>
            <p class="text-xs text-muted-foreground mt-1">
              {{ s.placeName }} · <span class="font-mono">{{ s.placePath }}</span> · {{ s.userCount }} user{{ s.userCount === 1 ? '' : 's' }}
            </p>
            <p v-if="s.excludedUsernames.length > 0" class="status-text text-warning mt-2">
              [WARN] No Linux account for {{ s.excludedUsernames.join(', ') }}: excluded from this share
            </p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" size="xs" @click="toggleEnabled(s)">
              {{ s.enabled ? 'Disable' : 'Enable' }}
            </Button>
            <Button variant="ghost" size="xs" @click="openEdit(s)">{{ t('ui.sharing.SharesSection.edit') }}</Button>
            <Button variant="destructive" size="xs" :disabled="deleting === s.id" @click="removeShare(s)">
              {{ t('ui.sharing.SharesSection.delete') }}
            </Button>
          </div>
        </div>
      </Card>
    </div>

    <!-- Create / edit modal -->
    <Modal v-if="editor" panel-class="w-full max-w-sm" @close="editor = null">
      <template #header>
        <h3 class="text-sm font-semibold text-foreground">
          {{ editor.id === null ? 'New share' : 'Edit share' }}
        </h3>
      </template>

      <div class="p-6 space-y-4">
        <div v-if="editor.id === null">
          <p class="eyebrow mb-2">{{ t('ui.sharing.SharesSection.place') }}</p>
          <NativeSelect wrapper-class="w-full" v-model="editor.placeId">
            <NativeSelectOption v-for="p in availablePlaces" :key="p.id" :value="p.id">
              {{ p.name }} · {{ p.path }}
            </NativeSelectOption>
          </NativeSelect>
        </div>

        <div>
          <p class="eyebrow mb-2">{{ t('ui.sharing.SharesSection.shareName') }}</p>
          <Input
            v-model="editor.smbName"
            type="text"
            :placeholder="t('ui.sharing.SharesSection.defaultsToThePlaceName')"
            class="w-full font-mono"
          />
          <p class="text-xs text-muted-foreground mt-1">{{ t('ui.sharing.SharesSection.lettersDigitsDotsDashesUnderscores') }}</p>
        </div>

        <label class="flex items-center gap-2 text-sm text-foreground/80 cursor-pointer">
          <Checkbox v-model="editor.readOnly" />
          {{ t('ui.sharing.SharesSection.readOnlyIgnoreWritePermissions') }}
        </label>
        <label class="flex items-center gap-2 text-sm text-foreground/80 cursor-pointer">
          <Checkbox v-model="editor.guestOk" />
          {{ t('ui.sharing.SharesSection.allowGuestAccessNoAuthentication') }}
        </label>

        <p v-if="editorError" class="status-text text-destructive">[ERR] {{ editorError }}</p>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="editor = null">{{ t('ui.sharing.SharesSection.cancel') }}</Button>
          <Button size="sm"
            :disabled="saving || (editor.id === null && !editor.placeId)"
            @click="save"
          >
            {{ saving ? 'Saving…' : editor.id === null ? 'Create share' : 'Save' }}
          </Button>
        </div>
      </template>
    </Modal>
  </div>
</template>
