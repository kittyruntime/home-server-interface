<script setup lang="ts">
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { canCloseReveal } from '../../lib/backup'
import Modal from '../ui/Modal.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// A repository password, shown once after it was generated ("new"), or on
// demand after the admin typed their own account password again ("ask").
const props = defineProps<{ mode: 'new' | 'ask'; repository: { id: string; name: string }; password?: string }>()
const emit = defineEmits<{ close: [] }>()

const modal = ref<InstanceType<typeof Modal> | null>(null)
const shown = ref(props.password ?? '')
const accountPassword = ref('')
const busy = ref(false)
const error = ref('')
const copied = ref(false)
const stored = ref(false)

// A generated password exists nowhere else yet: closing needs the tick.
const canClose = computed(() => canCloseReveal(props.mode, stored.value))

async function reveal() {
  if (!accountPassword.value) return
  busy.value = true
  error.value = ''
  try {
    shown.value = (await trpc.backup.password.mutate({ repository: props.repository.id, currentPassword: accountPassword.value })).password
    accountPassword.value = ''
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to read the password'
  } finally {
    busy.value = false
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(shown.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch { /* clipboard unavailable (non-secure context); the password stays selectable in the field */ }
}

function download() {
  const url = URL.createObjectURL(new Blob([shown.value + '\n'], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.repository.name}-restic-password.txt`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <Modal ref="modal" panel-class="w-full max-w-md" :show-close="canClose" :close-on-backdrop="canClose" :prevent-close="!canClose" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-foreground truncate">Password of {{ repository.name }}</h3>
    </template>

    <div class="px-5 py-4 space-y-4">
      <p class="text-sm text-foreground/80">Without this password the backups cannot be read, even by HSI on another server. It is also kept in the configuration backup.</p>

      <form v-if="!shown" class="space-y-3" @submit.prevent="reveal">
        <label class="block text-xs text-foreground/80">Your account password
          <Input v-model="accountPassword" type="password" autocomplete="current-password" class="mt-1 w-full" required />
        </label>
        <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
        <Button size="sm" type="submit" :disabled="busy || !accountPassword">
          <BusyLabel :busy="busy" busy-label="Verifying">Show the password</BusyLabel>
        </Button>
      </form>

      <template v-else>
        <Input :value="shown" readonly class="w-full font-mono text-sm" aria-label="Repository password" @focus="($event.target as HTMLInputElement).select()" />
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" type="button" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</Button>
          <Button variant="outline" size="sm" type="button" @click="download">Download</Button>
        </div>
        <label v-if="mode === 'new'" class="flex items-start gap-2 text-sm text-foreground">
          <input v-model="stored" type="checkbox" class="mt-0.5 accent-primary" />
          <span>I stored this password somewhere safe</span>
        </label>
      </template>
    </div>

    <template #footer>
      <div class="flex-1" />
      <Button size="sm" :disabled="!canClose" @click="modal?.requestClose()">Close</Button>
    </template>
  </Modal>
</template>
