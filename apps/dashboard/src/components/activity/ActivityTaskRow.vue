<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import {
  ArchiveIcon, ArchiveRestoreIcon, BoxIcon, CopyIcon, DatabaseBackupIcon, DownloadCloudIcon, FileCheckIcon,
  FolderInputIcon, FolderSearchIcon, PauseIcon, PlayIcon, Trash2Icon, UploadIcon, XIcon, CogIcon,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import SegmentedBar from '../ui/SegmentedBar.vue'
import { formatElapsed, type ActivityItem } from '../../lib/activity'
import { activityLabel } from '../../lib/activity-label'

/* One background task in the Activity panel and page. `now` ticks from the
   parent so every row's elapsed time moves together. */
const props = defineProps<{ item: ActivityItem; now: number }>()
const emit = defineEmits<{ pause: []; resume: []; cancel: []; reselect: []; retry: [] }>()
const { t } = useI18n()

const ICONS: Record<ActivityItem['kind'], Component> = {
  copy: CopyIcon,
  move: FolderInputIcon,
  delete: Trash2Icon,
  zip: ArchiveIcon,
  unzip: ArchiveRestoreIcon,
  finalize: FileCheckIcon,
  container: BoxIcon,
  backup: DatabaseBackupIcon,
  update: DownloadCloudIcon,
  upload: UploadIcon,
  other: CogIcon,
}

const label = computed(() => activityLabel(props.item, t))

const detail = computed(() => {
  const i = props.item
  if (i.status === 'error') return i.error ?? ''
  if (i.status === 'queued') return t('activity.queued')
  const parts: string[] = []
  if (i.percent !== null) parts.push(`${i.percent} %`)
  if (i.remainingSec !== null) parts.push(t('activity.remaining', { time: formatElapsed(i.remainingSec * 1000) }))
  if (i.startedAt && i.percent === null) {
    parts.push(t('activity.since', { time: formatElapsed(props.now - new Date(i.startedAt).getTime()) }))
  }
  return parts.join(' · ')
})

const owner = computed(() => {
  const o = props.item.owner
  if (o === 'me') return ''
  if (o === 'browser') return t('activity.owner.browser')
  if (o === 'system') return t('activity.owner.system')
  return t('activity.owner.user', { name: o.username })
})
</script>

<template>
  <div class="flex items-start gap-3 px-4 py-2.5">
    <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-base-200 text-base-content/70">
      <component :is="ICONS[item.kind] ?? FolderSearchIcon" class="size-4" aria-hidden="true" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm">{{ label }}</p>
      <p class="mt-0.5 truncate text-xs" :class="item.status === 'error' ? 'text-error' : 'text-base-content/70'">
        <span class="tabular-nums">{{ detail }}</span>
        <span v-if="owner"> · {{ owner }}</span>
      </p>
      <SegmentedBar v-if="item.status === 'running' || item.status === 'paused'" class="mt-1.5" :percent="item.percent ?? 0"
        :indeterminate="item.percent === null" height="compact" color="var(--color-primary)" />
      <Button v-if="item.interrupted" variant="link" class="mt-0.5 h-auto p-0 text-xs" @click="emit('reselect')">
        {{ t('activity.reselect') }}
      </Button>
      <Button v-else-if="item.kind === 'upload' && item.status === 'error'" variant="link" class="mt-0.5 h-auto p-0 text-xs" @click="emit('retry')">
        {{ t('activity.retry') }}
      </Button>
    </div>
    <Button v-if="item.pausable" variant="ghost" size="icon-xs" class="shrink-0 text-base-content/70" :tooltip="t('activity.pause')" :aria-label="t('activity.pause')" @click="emit('pause')">
      <PauseIcon />
    </Button>
    <Button v-if="item.kind === 'upload' && item.status === 'paused' && !item.interrupted" variant="ghost" size="icon-xs" class="shrink-0 text-base-content/70" :tooltip="t('activity.resume')" :aria-label="t('activity.resume')" @click="emit('resume')">
      <PlayIcon />
    </Button>
    <Button v-if="item.cancellable || item.kind === 'upload'" variant="ghost" size="icon-xs" class="shrink-0 text-base-content/70" :tooltip="t('activity.cancel')" :aria-label="t('activity.cancel')" @click="emit('cancel')">
      <XIcon />
    </Button>
  </div>
</template>
