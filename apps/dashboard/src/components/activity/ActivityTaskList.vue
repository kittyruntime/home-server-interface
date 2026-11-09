<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import ActivityTaskRow from './ActivityTaskRow.vue'
import type { ActivityItem } from '../../lib/activity'
import { useUploads } from '../../lib/uploads'
import { resumeByReselect } from '../../lib/upload-runner'
import { useActivity } from '../../lib/activity'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { useI18n } from 'vue-i18n'

/* Running background tasks with their actions. Uploads are driven here (they
   live in this browser); server tasks only show. */
defineProps<{ items: ActivityItem[] }>()

const uploads = useUploads()
const activity = useActivity()
const toast = useToast()
const { t } = useI18n()
// Cancels on their way: the task leaves the list once the NAS has cleaned up.
const cancelling = ref(new Set<string>())
const now = ref(Date.now())
const ticker = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(ticker))

// A reload loses the File: resuming needs the user to pick it again.
const reselectInput = ref<HTMLInputElement | null>(null)
const reselectId = ref<string | null>(null)

function reselect(id: string) {
  reselectId.value = id
  reselectInput.value?.click()
}

function picked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  const id = reselectId.value
  reselectId.value = null
  input.value = ''
  if (file && id) resumeByReselect(id, file)
}

async function cancel(item: ActivityItem) {
  if (item.kind === 'upload') { uploads.cancel(item.id); return }
  if (cancelling.value.has(item.id)) return
  cancelling.value = new Set([...cancelling.value, item.id])
  try {
    await trpc.tasks.cancel.mutate({ jobId: item.id })
    await activity.refresh()
  } catch (e) {
    toast.error(t('activity.cancelFailed', { error: e instanceof Error ? e.message : String(e) }))
  } finally {
    const next = new Set(cancelling.value)
    next.delete(item.id)
    cancelling.value = next
  }
}
</script>

<template>
  <ul class="divide-y divide-base-300">
    <li v-for="item in items" :key="item.id">
      <ActivityTaskRow :item="item" :now="now" :cancelling="cancelling.has(item.id)"
        @pause="uploads.pause(item.id)" @resume="uploads.resume(item.id)" @cancel="cancel(item)"
        @retry="uploads.retry(item.id)" @reselect="reselect(item.id)" />
    </li>
  </ul>
  <input ref="reselectInput" type="file" class="hidden" @change="picked">
</template>
