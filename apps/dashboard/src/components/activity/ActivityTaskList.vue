<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import ActivityTaskRow from './ActivityTaskRow.vue'
import type { ActivityItem } from '../../lib/activity'
import { useUploads } from '../../lib/uploads'
import { resumeByReselect } from '../../lib/upload-runner'

/* Running background tasks with their actions. Uploads are driven here (they
   live in this browser); server tasks only show. */
defineProps<{ items: ActivityItem[] }>()

const uploads = useUploads()
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

function cancel(item: ActivityItem) {
  if (item.kind === 'upload') uploads.cancel(item.id)
}
</script>

<template>
  <ul class="divide-y divide-base-300">
    <li v-for="item in items" :key="item.id">
      <ActivityTaskRow :item="item" :now="now"
        @pause="uploads.pause(item.id)" @resume="uploads.resume(item.id)" @cancel="cancel(item)"
        @retry="uploads.retry(item.id)" @reselect="reselect(item.id)" />
    </li>
  </ul>
  <input ref="reselectInput" type="file" class="hidden" @change="picked">
</template>
