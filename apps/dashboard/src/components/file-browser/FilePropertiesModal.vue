<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Progress } from '@/components/ui/progress'
import FileTypeIcon from './FileTypeIcon.vue'
import PlaceIcon from '../PlaceIcon.vue'
import { formatDateTime } from '../../lib/format-date'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { useAdvancedMode } from '../../lib/advanced-mode'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

type Entry = { name: string; path: string; type: 'file' | 'dir'; size: number | null; mtime: string }
type Place = { id: string; name: string; path: string; icon?: string | null }

const props = defineProps<{ entry?: Entry; place?: Place }>()
const emit  = defineEmits<{ close: []; openPermissions: [] }>()

const { isAdmin } = useAuth()
const { advancedMode } = useAdvancedMode()

// ── state ─────────────────────────────────────────────────────────────────────
const loading = ref(true)
const error   = ref('')

type StatInfo = {
  mode: string; owner: string; group: string; uid: number; gid: number
  type: string; size: number | null; mtime: string; ctime: string
}
type DiskInfo = { total: number; free: number }

const stat     = ref<StatInfo | null>(null)
const diskInfo = ref<DiskInfo | null>(null)

// ── derived ───────────────────────────────────────────────────────────────────
const targetPath = computed(() => props.entry?.path ?? props.place?.path ?? '')
const displayName = computed(() => props.entry?.name ?? props.place?.name ?? '')
const isPlace = computed(() => !!props.place)

const ext = computed(() => {
  const name = displayName.value
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
})

const KIND: Record<string, string> = {
  jpg: 'JPEG Image', jpeg: 'JPEG Image', png: 'PNG Image', gif: 'GIF Image',
  webp: 'WebP Image', bmp: 'Bitmap Image', svg: 'SVG Image', ico: 'Icon',
  avif: 'AVIF Image', mp4: 'MPEG-4 Video', webm: 'WebM Video', mov: 'QuickTime Video',
  mkv: 'MKV Video', avi: 'AVI Video', mp3: 'MP3 Audio', flac: 'FLAC Audio',
  wav: 'WAV Audio', ogg: 'OGG Audio', aac: 'AAC Audio', m4a: 'M4A Audio',
  pdf: 'PDF Document', txt: 'Plain Text File', md: 'Markdown File', json: 'JSON File',
  yaml: 'YAML File', yml: 'YAML File', xml: 'XML File', csv: 'CSV File',
  ts: 'TypeScript File', js: 'JavaScript File', vue: 'Vue Component',
  py: 'Python File', go: 'Go File', sh: 'Shell Script', dockerfile: 'Dockerfile',
  zip: 'ZIP Archive', tar: 'TAR Archive', gz: 'GZip Archive',
}

const kindLabel = computed(() => {
  if (stat.value?.type === 'dir') return isPlace.value ? 'Place' : 'Folder'
  if (!ext.value) return t('uis.files.FilePropertiesModal.file2')
  return KIND[ext.value] ?? t('uis.files.FilePropertiesModal.file', { p0: ext.value.toUpperCase() })
})

const modeSymbol = computed(() => {
  const mode = stat.value?.mode
  if (!mode) return ''
  const n = parseInt(mode, 8)
  const sym = (shift: number) => {
    const r = (n >> shift) & 4 ? 'r' : '-'
    const w = (n >> shift) & 2 ? 'w' : '-'
    const x = (n >> shift) & 1 ? 'x' : '-'
    return r + w + x
  }
  return sym(6) + sym(3) + sym(0)
})

const location = computed(() => {
  const p = targetPath.value
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
})

const diskUsed = computed(() => diskInfo.value ? diskInfo.value.total - diskInfo.value.free : 0)
const diskUsedPct = computed(() =>
  diskInfo.value && diskInfo.value.total > 0 ? (diskUsed.value / diskInfo.value.total) * 100 : 0
)

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}


// ── load ──────────────────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    const [s, d] = await Promise.all([
      trpc.fs.stat.query({ path: targetPath.value }),
      isPlace.value ? trpc.fs.diskUsage.query({ path: targetPath.value }) : Promise.resolve(null),
    ])
    stat.value = s
    diskInfo.value = d
  } catch (e: any) {
    error.value = e?.message ?? t('uis.files.FilePropertiesModal.failedToLoadProperties')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <Modal panel-class="w-full max-w-sm" @close="emit('close')">
    <template #header>
      <div class="flex items-center gap-3 min-w-0">
        <!-- Place icon -->
        <PlaceIcon v-if="isPlace" :icon="place?.icon" :root="place?.id === '__root__'" class="size-8 shrink-0 text-2xl text-muted-foreground" />
        <!-- Folder icon -->
        <FileTypeIcon v-else-if="entry?.type === 'dir'" :name="displayName" dir open class="w-8 h-8 shrink-0 text-muted-foreground" aria-hidden="true" />
        <!-- File icon -->
        <FileTypeIcon v-else :name="displayName" class="w-8 h-8 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="min-w-0">
          <div class="text-sm font-semibold text-foreground truncate">{{ displayName }}</div>
          <div class="text-2xs text-muted-foreground font-mono truncate mt-0.5">{{ targetPath }}</div>
        </div>
      </div>
    </template>

    <!-- Loading -->
    <LoadingState v-if="loading" variant="compact" />

    <!-- Error -->
    <p v-else-if="error" role="alert" class="p-6 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <!-- Content -->
    <div v-else class="divide-y divide-border">

      <!-- Disk usage (Places only) -->
      <div v-if="isPlace && diskInfo" class="px-5 py-4 space-y-2.5">
        <div class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.files.FilePropertiesModal.storage') }}</div>
        <Progress class="w-full h-2 bg-muted rounded-full" :model-value="Math.min(diskUsedPct, 100)" :indicator-class="['rounded-full transition-all', diskUsedPct > 90 ? 'bg-destructive' : 'bg-primary']" />
        <div class="flex justify-between text-xs text-muted-foreground">
          <span><span class="text-foreground font-medium">{{ fmtBytes(diskUsed) }}</span> used</span>
          <span><span class="text-foreground font-medium">{{ fmtBytes(diskInfo.free) }}</span> free</span>
          <span>{{ fmtBytes(diskInfo.total) }} total</span>
        </div>
      </div>

      <!-- General -->
      <div class="px-5 py-4 space-y-2.5">
        <div class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.files.FilePropertiesModal.general') }}</div>
        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.kind') }}</dt>
            <dd class="text-foreground text-right truncate">{{ kindLabel }}</dd>
          </div>
          <div v-if="stat?.size != null" class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.size') }}</dt>
            <dd class="text-foreground text-right">{{ fmtBytes(stat.size) }}</dd>
          </div>
          <div v-if="!isPlace" class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.location') }}</dt>
            <dd class="text-foreground/80 text-right font-mono text-xs truncate">{{ location }}</dd>
          </div>
        </dl>
      </div>

      <!-- Dates -->
      <div v-if="stat?.mtime" class="px-5 py-4 space-y-2.5">
        <div class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.files.FilePropertiesModal.dates') }}</div>
        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.modified') }}</dt>
            <dd class="text-foreground text-right">{{ formatDateTime(stat.mtime) }}</dd>
          </div>
          <div v-if="stat.ctime" class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.changed') }}</dt>
            <dd class="text-foreground text-right">{{ formatDateTime(stat.ctime) }}</dd>
          </div>
        </dl>
      </div>

      <!-- Permissions -->
      <div v-if="stat" class="px-5 py-4 space-y-2.5">
        <div class="flex items-center justify-between">
          <div class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.files.FilePropertiesModal.permissions') }}</div>
          <Button variant="link"
            v-if="isAdmin"
            @click="emit('close'); emit('openPermissions')"
            class="h-auto p-0 text-primary"
          >{{ t('ui.files.FilePropertiesModal.edit') }}</Button>
        </div>
        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.mode') }}</dt>
            <dd class="font-mono text-foreground">{{ modeSymbol }} <span class="text-muted-foreground">({{ stat.mode }})</span></dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.owner') }}</dt>
            <dd class="font-mono text-foreground">{{ stat.owner }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.group') }}</dt>
            <dd class="font-mono text-foreground">{{ stat.group }}</dd>
          </div>
          <template v-if="advancedMode">
            <div class="flex justify-between gap-4">
              <dt class="text-muted-foreground shrink-0">{{ t('ui.files.FilePropertiesModal.uidGid') }}</dt>
              <dd class="font-mono text-foreground">{{ stat.uid }} / {{ stat.gid }}</dd>
            </div>
          </template>
        </dl>
      </div>

    </div>

    <template #footer>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" @click="emit('close')">{{ t('ui.files.FilePropertiesModal.close') }}</Button>
    </template>
  </Modal>
</template>
