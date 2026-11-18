<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize } from '@vueuse/core'
import { ChevronLeftIcon, CircleAlertIcon, HistoryIcon, PencilIcon, PlusIcon, PowerIcon, Trash2Icon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import LoadingState from '../ui/LoadingState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import ShareList from './ShareList.vue'
import ShareDetail from './ShareDetail.vue'
import ShareEditor from './ShareEditor.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { useVolumeHolds } from '../../lib/volumes'
import { connectInfo, type ShareDetailData, type ShareListRow, type SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null }>()
const emit = defineEmits<{ seeAll: [share: string]; changed: []; openServices: [] }>()

const { t } = useI18n()
const toast = useToast()

type PlaceRow = { id: string; name: string; path: string }

const shares = ref<ShareListRow[]>([])
const places = ref<PlaceRow[]>([])
const loading = ref(true)
const error = ref('')
const selectedId = ref<string | null>(null)
const selected = computed(() => shares.value.find(s => s.id === selectedId.value) ?? null)
// The full share, once the detail loaded it: what the editor starts from.
const detail = ref<ShareDetailData['share'] | null>(null)

const root = useTemplateRef<HTMLElement>('root')
const { width } = useElementSize(root)
// Below 48rem the list fills the space and the detail opens over it.
const narrow = computed(() => width.value > 0 && width.value < 768)

const smbState = computed(() => {
  const s = props.service?.state
  if (!s) return 'unknown'
  if (!s.installed) return 'missing'
  return s.active ? 'on' : 'stopped'
})
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

const retrying = ref(false)
async function retry() {
  retrying.value = true
  await refresh()
  retrying.value = false
}

function select(id: string) {
  if (id !== selectedId.value) detail.value = null
  selectedId.value = id
}

// null = closed; 'new' creates; 'edit' edits the selected share.
const editing = ref<'new' | 'edit' | null>(null)
async function onSaved() {
  editing.value = null
  await refresh()
  detailRef.value?.reload()
  emit('changed')
}

const detailRef = useTemplateRef<InstanceType<typeof ShareDetail>>('detailRef')
const pending = ref<'toggle' | 'remove' | null>(null)

async function toggle() {
  const s = selected.value
  if (!s || pending.value) return
  pending.value = 'toggle'
  try {
    await applyPlanned('share.update', { id: s.id, enabled: !s.enabled }, {
      domain: 'sharing',
      title: s.enabled ? t('sharing.detail.disablePlan', { name: s.effectiveName }) : t('sharing.detail.enablePlan', { name: s.effectiveName }),
      actionLabel: s.enabled ? t('sharing.detail.disable') : t('sharing.detail.enable'),
      danger: s.enabled,
    })
    await refresh()
    detailRef.value?.reload()
    emit('changed')
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  } finally {
    pending.value = null
  }
}

async function remove() {
  const s = selected.value
  if (!s || pending.value) return
  pending.value = 'remove'
  try {
    await applyPlanned('share.remove', { id: s.id }, {
      domain: 'sharing', title: t('sharing.detail.removePlan', { name: s.effectiveName }), actionLabel: t('sharing.detail.stopSharing'), danger: true,
    })
    selectedId.value = null
    detail.value = null
    await refresh()
    emit('changed')
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  } finally {
    pending.value = null
  }
}

const protocols = (s: ShareListRow) => [s.smb && 'SMB', s.nfs && 'NFS', s.sftp && 'SFTP'].filter(Boolean) as string[]
</script>

<template>
  <section ref="root" class="@container space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.list.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.list.subtitle') }}</p>
    </div>

    <Alert v-if="smbState === 'missing' || smbState === 'stopped'" class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <CircleAlertIcon class="size-4 text-warning" aria-hidden="true" />
      <AlertDescription class="min-w-0 flex-1">{{ smbState === 'missing' ? t('sharing.banner.missing') : t('sharing.banner.stopped') }}</AlertDescription>
      <Button variant="outline" size="xs" class="shrink-0" @click="emit('openServices')">{{ t('sharing.list.openServices') }}</Button>
    </Alert>
    <Alert v-if="error" variant="destructive" class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <AlertDescription class="min-w-0 flex-1">{{ error }}</AlertDescription>
      <Button variant="outline" size="xs" class="shrink-0" :disabled="retrying" @click="retry">
        <BusyLabel :busy="retrying">{{ t('common.retry') }}</BusyLabel>
      </Button>
    </Alert>

    <LoadingState v-if="loading" variant="compact" />

    <template v-else-if="!(error && shares.length === 0)">
      <!-- Narrow: the detail replaces the list, with a way back. -->
      <div v-if="narrow && selectedId" class="flex items-center gap-2">
        <Button variant="ghost" size="sm" class="-ml-2 mr-auto gap-1 text-primary" @click="selectedId = null; detail = null">
          <ChevronLeftIcon class="size-4" />{{ t('sharing.detail.back') }}
        </Button>
      </div>

      <Card class="gap-0 overflow-hidden py-0">
        <div role="toolbar" :aria-label="t('sharing.list.actions')" class="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-200/40 px-3 py-2">
          <Button v-if="!(narrow && selectedId)" size="sm" :disabled="availablePlaces.length === 0"
            :title="availablePlaces.length === 0 ? t('sharing.list.allShared') : undefined" @click="editing = 'new'">
            <PlusIcon class="size-4" />{{ t('sharing.list.newShare') }}
          </Button>
          <template v-if="shares.length && (!narrow || selectedId)">
            <Button variant="ghost" size="sm" :disabled="!selected || !detail || !!pending" @click="editing = 'edit'">
              <PencilIcon class="size-4" />{{ t('sharing.detail.edit') }}
            </Button>
            <Button variant="ghost" size="sm" :disabled="!selected || !!pending" @click="toggle">
              <PowerIcon class="size-4" />
              <BusyLabel :busy="pending === 'toggle'">{{ selected && !selected.enabled ? t('sharing.detail.enable') : t('sharing.detail.disable') }}</BusyLabel>
            </Button>
            <Button variant="ghost" size="sm" :class="selected && !pending && 'text-error'" :disabled="!selected || !!pending" @click="remove">
              <Trash2Icon class="size-4" />
              <BusyLabel :busy="pending === 'remove'">{{ t('sharing.detail.delete') }}</BusyLabel>
            </Button>
          </template>
          <span v-if="!narrow && shares.length" class="ml-auto pr-1 text-xs text-base-content/70 tabular-nums">{{ t('sharing.list.count', { n: shares.length }, shares.length) }}</span>
        </div>

        <p v-if="shares.length === 0 && !error" class="px-4 py-10 text-center text-sm text-base-content/70">{{ t('sharing.list.empty') }}</p>

        <!-- Wide: a table of every share. -->
        <div v-else-if="!narrow" class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr class="text-xs text-base-content/70">
                <th scope="col" class="font-medium">{{ t('sharing.list.colName') }}</th>
                <th scope="col" class="font-medium">{{ t('sharing.list.colLocation') }}</th>
                <th scope="col" class="font-medium">{{ t('sharing.list.colProtocols') }}</th>
                <th scope="col" class="font-medium">{{ t('sharing.list.colAccess') }}</th>
                <th scope="col" class="font-medium">{{ t('sharing.list.colStatus') }}</th>
                <th scope="col" class="text-right font-medium">{{ t('sharing.list.colConnected') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in shares" :key="s.id" class="cursor-pointer transition-colors duration-(--dur-fast)"
                :class="s.id === selectedId ? 'bg-primary/10' : 'hover:bg-base-200/60'" @click="select(s.id)">
                <td class="max-w-56">
                  <button type="button" class="flex max-w-full items-center gap-1.5 text-left font-medium text-base-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    :class="!s.enabled && 'text-base-content/60'" :aria-current="s.id === selectedId ? 'true' : undefined" @click.stop="select(s.id)">
                    <span class="truncate">{{ s.effectiveName }}</span>
                    <HistoryIcon v-if="s.timeMachine" class="size-3.5 shrink-0 text-base-content/60" :aria-label="t('sharing.detail.timeMachineOption')" role="img" />
                  </button>
                </td>
                <td class="max-w-64">
                  <span class="block truncate text-base-content/90">{{ s.placeName }}</span>
                  <span class="block truncate font-mono text-2xs text-base-content/60" :title="s.placePath">{{ s.placePath }}</span>
                </td>
                <td>
                  <span class="flex gap-1">
                    <span v-for="p in protocols(s)" :key="p" class="badge badge-ghost badge-sm font-medium">{{ p }}</span>
                  </span>
                </td>
                <td class="text-base-content/80">{{ s.readOnly ? t('sharing.list.readOnly') : t('sharing.list.readWrite') }}</td>
                <td>
                  <span v-if="!s.enabled" class="flex items-center gap-1.5 text-base-content/60"><span class="size-1.5 rounded-full bg-base-content/40" aria-hidden="true" />{{ t('sharing.list.disabled') }}</span>
                  <span v-else-if="unavailable(s.placePath)" class="flex items-center gap-1.5 text-error"><span class="size-1.5 rounded-full bg-error" aria-hidden="true" />{{ t('sharing.list.unavailable') }}</span>
                  <span v-else-if="s.problem" class="flex items-center gap-1.5 text-warning"><CircleAlertIcon class="size-3.5" aria-hidden="true" />{{ t('sharing.list.problem') }}</span>
                  <span v-else class="flex items-center gap-1.5 text-success"><span class="size-1.5 rounded-full bg-success" aria-hidden="true" />{{ t('sharing.detail.active') }}</span>
                </td>
                <td class="text-right tabular-nums">
                  <span v-if="s.connected > 0" class="inline-flex items-center gap-1.5 font-medium text-base-content">
                    <span class="size-1.5 rounded-full bg-success" aria-hidden="true" />{{ s.connected }}
                  </span>
                  <span v-else class="text-base-content/50"><span aria-hidden="true">–</span><span class="sr-only">{{ t('sharing.list.nobodyConnected') }}</span></span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Narrow: one card row per share. -->
        <ShareList v-else-if="!selectedId" :shares="shares" :selected-id="selectedId" :unavailable="unavailable" @select="select" />

        <div v-if="selectedId && shares.length" :class="!narrow && 'border-t border-base-300'">
          <ShareDetail ref="detailRef" :id="selectedId" :connect="connect" @loaded="s => detail = s" @see-all="name => emit('seeAll', name)" />
        </div>
      </Card>
    </template>

    <ShareEditor v-if="editing === 'new'" :share="null" :places="availablePlaces" :service="service" @close="editing = null" @saved="onSaved" />
    <ShareEditor v-else-if="editing === 'edit' && detail" :share="detail" :place-id="selected?.placeId" :place-name="selected?.placeName"
      :places="[]" :service="service" @close="editing = null" @saved="onSaved" />
  </section>
</template>
