<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import { FileIcon, FolderIcon, LayersIcon, LinkIcon } from '@lucide/vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import LoadingState from '../ui/LoadingState.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { fmtBytes } from './store'
import { formatDateTime } from '../../lib/format-date'
import { crumbs, joinPath } from './snapshot-model'

// Browse a snapshot read-only and copy a file or a folder back next to its
// original, under a "restored" name: nothing in place is overwritten.
const props = defineProps<{ snapshot: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const toast = useToast()
type Entry = { name: string; kind: 'dir' | 'file' | 'link' | 'dataset' | 'other'; size: number; mtime: number }
const path = ref('')
const entries = ref<Entry[]>([])
const truncated = ref(false)
const loading = ref(true)
const error = ref('')

async function open(p: string) {
  loading.value = true
  error.value = ''
  try {
    const r = await trpc.storage.zfs.snapshotLs.query({ snapshot: props.snapshot, path: p })
    entries.value = r.entries
    truncated.value = r.truncated
    path.value = p
  } catch (e: any) {
    error.value = e?.message ?? t('ui.storage.Zfs.failed')
  } finally {
    loading.value = false
  }
}
onMounted(() => { void open('') })

async function restore(e: Entry) {
  const p = joinPath(path.value, e.name)
  try {
    await applyPlanned('zfs.snapshot.restore', { snapshot: props.snapshot, path: p }, {
      title: t('ui.storage.ZfsSnap.restoreTitle', { path: p }), actionLabel: t('ui.storage.ZfsSnap.restore'),
    })
    toast.success(t('ui.storage.ZfsSnap.restored', { path: p }))
  } catch (err: any) {
    if (err?.message !== '') toast.error(err?.message ?? t('ui.storage.Zfs.failed'))
  }
}
const ICON = { dir: FolderIcon, file: FileIcon, link: LinkIcon, dataset: LayersIcon, other: FileIcon }
</script>

<template>
  <Modal :label="t('ui.storage.ZfsSnap.browseHeading')" panel-class="w-full max-w-2xl" @close="emit('close')">
    <template #header>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-base-content">{{ t('ui.storage.ZfsSnap.browseHeading') }}</h3>
        <p class="mt-0.5 break-all font-mono text-xs text-base-content/70">{{ snapshot }}</p>
        <nav class="mt-2 flex flex-wrap items-center gap-1 text-sm" :aria-label="t('ui.storage.ZfsSnap.where')">
          <button type="button" class="link link-hover" @click="open('')">{{ t('ui.storage.ZfsSnap.root') }}</button>
          <template v-for="c in crumbs(path)" :key="c.path">
            <span class="text-base-content/50">/</span>
            <button type="button" class="link link-hover break-all" @click="open(c.path)">{{ c.name }}</button>
          </template>
        </nav>
      </div>
    </template>
    <div class="max-h-[60vh] overflow-y-auto p-2">
      <LoadingState v-if="loading" variant="block" />
      <p v-else-if="error" class="p-3 text-sm text-error">{{ error }}</p>
      <p v-else-if="!entries.length" class="p-3 text-sm text-base-content/70">{{ t('ui.storage.ZfsSnap.emptyFolder') }}</p>
      <ul v-else>
        <li v-for="e in entries" :key="e.name" class="group flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-base-200">
          <component :is="ICON[e.kind]" class="size-4 shrink-0 text-base-content/70" aria-hidden="true" />
          <button v-if="e.kind === 'dir'" type="button" class="min-w-0 flex-1 truncate text-left text-sm link link-hover" @click="open(joinPath(path, e.name))">{{ e.name }}</button>
          <span v-else class="min-w-0 flex-1 truncate text-sm">{{ e.name }}<span v-if="e.kind === 'dataset'" class="ml-2 text-xs text-base-content/70">{{ t('ui.storage.ZfsSnap.childDataset') }}</span></span>
          <span class="hidden shrink-0 text-xs text-base-content/70 tabular-nums sm:inline">{{ e.kind === 'file' ? fmtBytes(e.size) : '' }}</span>
          <span class="hidden shrink-0 text-xs text-base-content/70 md:inline">{{ formatDateTime(e.mtime * 1000) }}</span>
          <Button v-if="e.kind !== 'dataset'" variant="ghost" size="xs" class="shrink-0" @click="restore(e)">{{ t('ui.storage.ZfsSnap.restore') }}</Button>
        </li>
      </ul>
      <p v-if="truncated" class="p-3 text-xs text-warning">{{ t('ui.storage.ZfsSnap.truncated') }}</p>
    </div>
    <p class="border-t border-base-300 px-5 py-3 text-xs text-base-content/70">{{ t('ui.storage.ZfsSnap.restoreHint') }}</p>
  </Modal>
</template>
