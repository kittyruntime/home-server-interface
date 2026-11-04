<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { trpc } from '../../lib/trpc'
import { formatBytes, formatDuration } from '../../lib/file-details'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import CopyPath from './CopyPath.vue'

// The heavy details of the properties dialog (#198): computed only when asked,
// and dropped when the dialog closes (the worker stops at its own deadline).
const props = defineProps<{ path: string; isDir: boolean; mime?: string }>()
const { t } = useI18n()

type Kind = 'folderSize' | 'checksum' | 'media'
type FolderSize = { files: number; folders: number; bytes: number; partial: boolean }
type Media = { width?: number; height?: number; duration?: number; format?: string; video?: string; audio?: string; probed: boolean }

const busy = ref<Kind | null>(null)
const error = ref('')
const size = ref<FolderSize | null>(null)
const sha = ref('')
const media = ref<Media | null>(null)
let controller: AbortController | null = null

const isMedia = computed(() => !props.isDir && /^(image|video|audio)\//.test(props.mime ?? ''))

async function run(kind: Kind) {
  controller?.abort()
  controller = new AbortController()
  busy.value = kind
  error.value = ''
  try {
    const r = await trpc.fs.details.query({ path: props.path, kind }, { signal: controller.signal })
    if (kind === 'folderSize') size.value = r as FolderSize
    else if (kind === 'checksum') sha.value = (r as { sha256: string }).sha256
    else media.value = r as Media
  } catch (e: unknown) {
    if (controller?.signal.aborted) return
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (busy.value === kind) busy.value = null
  }
}

onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div class="px-5 py-4 space-y-2.5">
    <div class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('files.details.title') }}</div>

    <dl class="space-y-1.5 text-sm">
      <!-- Folder: size of everything inside -->
      <div v-if="isDir" class="flex items-center justify-between gap-4">
        <dt class="text-base-content/70 shrink-0">{{ t('files.details.contents') }}</dt>
        <dd class="text-right">
          <span v-if="size" class="tabular-nums">
            {{ t('files.details.contentsValue', { files: size.files, folders: size.folders, size: formatBytes(size.bytes) }) }}
            <span v-if="size.partial" class="block text-xs text-warning">{{ t('files.details.partial') }}</span>
          </span>
          <LoadingSpinner v-else-if="busy === 'folderSize'" :label="t('files.details.calculating')" />
          <Button v-else variant="link" size="sm" class="h-auto p-0" @click="run('folderSize')">{{ t('files.details.calculate') }}</Button>
        </dd>
      </div>

      <!-- File: checksum -->
      <div v-if="!isDir" class="flex items-center justify-between gap-4">
        <dt class="text-base-content/70 shrink-0">SHA-256</dt>
        <dd class="min-w-0 text-right">
          <CopyPath v-if="sha" :path="sha" class="max-w-full font-mono text-xs">{{ sha }}</CopyPath>
          <LoadingSpinner v-else-if="busy === 'checksum'" :label="t('files.details.calculating')" />
          <Button v-else variant="link" size="sm" class="h-auto p-0" @click="run('checksum')">{{ t('files.details.compute') }}</Button>
        </dd>
      </div>

      <!-- Image, video, audio -->
      <template v-if="isMedia">
        <template v-if="media">
          <div v-if="media.width && media.height" class="flex justify-between gap-4">
            <dt class="text-base-content/70 shrink-0">{{ t('files.details.dimensions') }}</dt>
            <dd class="text-right tabular-nums">{{ media.width }} × {{ media.height }}</dd>
          </div>
          <div v-if="media.duration" class="flex justify-between gap-4">
            <dt class="text-base-content/70 shrink-0">{{ t('files.details.duration') }}</dt>
            <dd class="text-right tabular-nums">{{ formatDuration(media.duration) }}</dd>
          </div>
          <div v-if="media.video || media.audio" class="flex justify-between gap-4">
            <dt class="text-base-content/70 shrink-0">{{ t('files.details.codecs') }}</dt>
            <dd class="text-right">{{ [media.video, media.audio].filter(Boolean).join(' · ') }}</dd>
          </div>
          <div v-if="media.format" class="flex justify-between gap-4">
            <dt class="text-base-content/70 shrink-0">{{ t('files.details.container') }}</dt>
            <dd class="text-right truncate">{{ media.format }}</dd>
          </div>
          <p v-if="!media.probed && !media.width" class="text-xs text-base-content/70">{{ t('files.details.noProbe') }}</p>
        </template>
        <div v-else class="flex items-center justify-between gap-4">
          <dt class="text-base-content/70 shrink-0">{{ t('files.details.media') }}</dt>
          <dd class="text-right">
            <LoadingSpinner v-if="busy === 'media'" :label="t('files.details.reading')" />
            <Button v-else variant="link" size="sm" class="h-auto p-0" @click="run('media')">{{ t('files.details.read') }}</Button>
          </dd>
        </div>
      </template>
    </dl>

    <p v-if="error" role="alert" class="text-xs text-error">{{ error }}</p>
  </div>
</template>
