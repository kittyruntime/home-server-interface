<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcwIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { useConfirm } from '../../lib/confirm'
import { formatBytes } from '../../lib/file-details'
import { formatDateTime } from '../../lib/format-date'
import LoadingState from '../ui/LoadingState.vue'
import EmptyState from '../ui/EmptyState.vue'
import FileTypeIcon from './FileTypeIcon.vue'

// Items deleted in places that have a trash (#200), grouped by place, newest
// first: restore them where they were, or remove them for good.
type Entry = { id: string; name: string; originalPath: string; deletedAt: string; deletedBy?: string; type: 'file' | 'dir'; size: number | null }
type Group = { placeId: string; placeName: string; placePath: string; entries: Entry[]; error?: string }

const emit = defineEmits<{ restored: [path: string] }>()
const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirm()

const groups = ref<Group[]>([])
const loading = ref(true)
const busy = ref<string | null>(null)
const total = computed(() => groups.value.reduce((n, g) => n + g.entries.length, 0))

async function load() {
  loading.value = true
  try { groups.value = await trpc.trash.list.query() as Group[] }
  catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  finally { loading.value = false }
}

function folderOf(path: string) {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** "name (restored)" next to the original, keeping the extension. */
function restoredName(path: string) {
  const dir = folderOf(path)
  const name = path.slice(dir === '/' ? 1 : dir.length + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${dir === '/' ? '' : dir}/${stem} (${t('files.trash.restoredSuffix')})${ext}`
}

async function restore(g: Group, e: Entry) {
  busy.value = e.id
  try {
    const r = await trpc.trash.restore.mutate({ placeId: g.placeId, id: e.id })
    toast.success(t('files.trash.restored', { name: e.name }))
    emit('restored', r.path)
  } catch (err: unknown) {
    const taken = (err as { data?: { code?: string } })?.data?.code === 'CONFLICT' || /already exists/i.test(String((err as Error)?.message))
    if (!taken) { toast.error(err instanceof Error ? err.message : String(err)); return }
    const target = restoredName(e.originalPath)
    const ok = await confirm(t('files.trash.takenMessage', { path: e.originalPath, target }), {
      title: t('files.trash.takenTitle'), confirmLabel: t('files.trash.restoreAs'),
    })
    if (ok) {
      try {
        const r = await trpc.trash.restore.mutate({ placeId: g.placeId, id: e.id, target })
        toast.success(t('files.trash.restored', { name: e.name }))
        emit('restored', r.path)
      } catch (err2: unknown) { toast.error(err2 instanceof Error ? err2.message : String(err2)) }
    }
  } finally {
    busy.value = null
    await load()
  }
}

async function remove(g: Group, e: Entry) {
  const ok = await confirm(t('files.trash.deleteMessage', { name: e.name }), {
    title: t('fileDelete.title'), confirmLabel: t('fileDelete.confirm'), danger: true,
  })
  if (!ok) return
  busy.value = e.id
  try { await trpc.trash.delete.mutate({ placeId: g.placeId, ids: [e.id] }) }
  catch (err: unknown) { toast.error(err instanceof Error ? err.message : String(err)) }
  finally { busy.value = null; await load() }
}

async function empty(g: Group) {
  const ok = await confirm(t('files.trash.emptyMessage', { count: g.entries.length, name: g.placeName }), {
    title: t('files.trash.emptyTitle'), confirmLabel: t('files.trash.empty'), danger: true,
  })
  if (!ok) return
  busy.value = g.placeId
  try { await trpc.trash.empty.mutate({ placeId: g.placeId }) }
  catch (err: unknown) { toast.error(err instanceof Error ? err.message : String(err)) }
  finally { busy.value = null; await load() }
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div class="space-y-6">
    <p class="max-w-md text-xs leading-relaxed text-base-content/70">{{ t('files.trash.intro') }}</p>

    <LoadingState v-if="loading && !groups.length" variant="compact" />
    <div v-else-if="!groups.length" class="rounded-box border border-dashed border-base-300">
      <EmptyState :message="t('files.trash.noPlaces')" :description="t('files.trash.noPlacesHint')" />
    </div>

    <section v-for="g in groups" :key="g.placeId" class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold">{{ g.placeName }} <span class="font-normal text-base-content/70 tabular-nums">· {{ g.entries.length }}</span></h3>
        <Button v-if="g.entries.length" variant="ghost" size="sm" :disabled="busy === g.placeId" @click="empty(g)">
          <Trash2Icon aria-hidden="true" /> {{ t('files.trash.empty') }}
        </Button>
      </div>
      <p v-if="g.error" role="alert" class="text-xs text-error">{{ g.error }}</p>
      <div v-else-if="!g.entries.length" class="rounded-box border border-dashed border-base-300 px-4 py-3 text-xs text-base-content/70">{{ t('files.trash.emptyPlace') }}</div>
      <Card v-else class="block gap-0 py-0 overflow-hidden divide-y divide-base-300 shadow-none">
        <div v-for="e in g.entries" :key="e.id" class="flex items-center gap-3 px-4 py-2.5">
          <FileTypeIcon :name="e.name" :dir="e.type === 'dir'" class="size-5 shrink-0" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm" :title="e.name">{{ e.name }}</div>
            <div class="truncate text-xs text-base-content/70">
              <span class="font-mono">{{ folderOf(e.originalPath) }}</span>
              · {{ formatDateTime(e.deletedAt) }}<template v-if="e.deletedBy"> · {{ e.deletedBy }}</template><template v-if="e.size != null"> · <span class="tabular-nums">{{ formatBytes(e.size) }}</span></template>
            </div>
          </div>
          <Button variant="ghost" size="sm" :disabled="busy === e.id" @click="restore(g, e)">
            <RotateCcwIcon aria-hidden="true" /> {{ t('files.trash.restore') }}
          </Button>
          <Button variant="ghost" size="icon-sm" :disabled="busy === e.id" :tooltip="t('files.trash.deleteForever')" :aria-label="t('files.trash.deleteForeverNamed', { name: e.name })" @click="remove(g, e)">
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </Card>
    </section>
    <span class="sr-only" aria-live="polite">{{ t('files.trash.count', { count: total }) }}</span>
  </div>
</template>
