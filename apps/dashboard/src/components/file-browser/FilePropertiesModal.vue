<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import Modal from '../ui/Modal.vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'

type Entry = { name: string; path: string; type: 'file' | 'dir'; size: number | null; mtime: string }
type Place = { id: string; name: string; path: string }

const props = defineProps<{ entry?: Entry; place?: Place }>()
const emit  = defineEmits<{ close: []; openPermissions: [] }>()

const { isAdmin } = useAuth()

// ── state ─────────────────────────────────────────────────────────────────────
const loading = ref(true)
const error   = ref('')

type StatInfo = { mode: string; owner: string; group: string; type: string; size: number | null; mtime: string; ctime: string }
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
  if (!ext.value) return 'File'
  return KIND[ext.value] ?? `${ext.value.toUpperCase()} File`
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

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))
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
    error.value = e?.message ?? 'Failed to load properties'
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
        <svg v-if="isPlace" class="w-8 h-8 shrink-0 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
        </svg>
        <!-- Folder icon -->
        <svg v-else-if="entry?.type === 'dir'" class="w-8 h-8 shrink-0 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/>
        </svg>
        <!-- File icon -->
        <svg v-else class="w-8 h-8 shrink-0 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
        </svg>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-[var(--c-text-1)] truncate">{{ displayName }}</div>
          <div class="text-[11px] text-[var(--c-text-3)] font-mono truncate mt-0.5">{{ targetPath }}</div>
        </div>
      </div>
    </template>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm p-6">
      <LoadingSpinner />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="p-6 text-sm text-[var(--c-danger)]">{{ error }}</div>

    <!-- Content -->
    <div v-else class="divide-y divide-[var(--c-border)]">

      <!-- Disk usage (Places only) -->
      <div v-if="isPlace && diskInfo" class="px-5 py-4 space-y-2.5">
        <div class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Storage</div>
        <div class="w-full h-2 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all"
            :class="diskUsedPct > 90 ? 'bg-[var(--c-danger)]' : 'bg-[var(--c-accent)]'"
            :style="{ width: `${Math.min(diskUsedPct, 100)}%` }"
          />
        </div>
        <div class="flex justify-between text-xs text-[var(--c-text-3)]">
          <span><span class="text-[var(--c-text-1)] font-medium">{{ fmtBytes(diskUsed) }}</span> used</span>
          <span><span class="text-[var(--c-text-1)] font-medium">{{ fmtBytes(diskInfo.free) }}</span> free</span>
          <span>{{ fmtBytes(diskInfo.total) }} total</span>
        </div>
      </div>

      <!-- General -->
      <div class="px-5 py-4 space-y-2.5">
        <div class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">General</div>
        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Kind</dt>
            <dd class="text-[var(--c-text-1)] text-right truncate">{{ kindLabel }}</dd>
          </div>
          <div v-if="stat?.size != null" class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Size</dt>
            <dd class="text-[var(--c-text-1)] text-right">{{ fmtBytes(stat.size) }}</dd>
          </div>
          <div v-if="!isPlace" class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Location</dt>
            <dd class="text-[var(--c-text-2)] text-right font-mono text-xs truncate">{{ location }}</dd>
          </div>
        </dl>
      </div>

      <!-- Dates -->
      <div v-if="stat?.mtime" class="px-5 py-4 space-y-2.5">
        <div class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Dates</div>
        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Modified</dt>
            <dd class="text-[var(--c-text-1)] text-right">{{ fmtDate(stat.mtime) }}</dd>
          </div>
          <div v-if="stat.ctime" class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Changed</dt>
            <dd class="text-[var(--c-text-1)] text-right">{{ fmtDate(stat.ctime) }}</dd>
          </div>
        </dl>
      </div>

      <!-- Permissions -->
      <div v-if="stat" class="px-5 py-4 space-y-2.5">
        <div class="flex items-center justify-between">
          <div class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Permissions</div>
          <button
            v-if="isAdmin"
            @click="emit('close'); emit('openPermissions')"
            class="text-xs text-[var(--c-accent)] hover:underline"
          >Edit…</button>
        </div>
        <dl class="space-y-1.5 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Mode</dt>
            <dd class="font-mono text-[var(--c-text-1)]">{{ modeSymbol }} <span class="text-[var(--c-text-3)]">({{ stat.mode }})</span></dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Owner</dt>
            <dd class="font-mono text-[var(--c-text-1)]">{{ stat.owner }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-[var(--c-text-3)] shrink-0">Group</dt>
            <dd class="font-mono text-[var(--c-text-1)]">{{ stat.group }}</dd>
          </div>
        </dl>
      </div>

    </div>

    <template #footer>
      <div class="flex-1" />
      <button @click="emit('close')" class="btn btn-ghost btn-sm">Close</button>
    </template>
  </Modal>
</template>
