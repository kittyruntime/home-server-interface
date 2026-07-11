<script setup lang="ts">
import { ref } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'

const props = defineProps<{ path: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

const usePassword = ref(false)
const password = ref('')
const expiresInDays = ref<number | null>(7)
const useLimit = ref(false)
const maxDownloads = ref(1)
const busy = ref(false)
const error = ref('')
const url = ref('')
const copied = ref(false)

async function create() {
  busy.value = true; error.value = ''
  try {
    const r = await trpc.shareLink.create.mutate({
      path: props.path,
      password: usePassword.value && password.value ? password.value : undefined,
      expiresInDays: expiresInDays.value ?? undefined,
      maxDownloads: useLimit.value ? maxDownloads.value : undefined,
    })
    url.value = `${window.location.origin}/s/${r.token}`
  } catch (e: unknown) {
    const err = e as { message?: string; data?: { code?: string } }
    error.value = err?.data?.code === 'FORBIDDEN'
      ? 'You do not have permission to share this folder.'
      : (err?.message ?? 'Failed to create link')
  } finally { busy.value = false }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true; setTimeout(() => (copied.value = false), 1500)
  } catch { /* clipboard unavailable (non-secure context) — the URL stays selectable in the field */ }
}
</script>

<template>
  <Modal panel-class="w-full max-w-md" :show-close="false" @close="emit('close')">
    <div class="p-6 space-y-4">
      <h3 class="text-base font-semibold text-[var(--c-text-1)]">Share "{{ name }}"</h3>

      <template v-if="!url">
        <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)]">
          <input type="checkbox" v-model="usePassword" class="accent-accent" /> Password protect
        </label>
        <input v-if="usePassword" v-model="password" type="password" class="ui-input" placeholder="Password" />

        <div>
          <label class="block text-xs text-[var(--c-text-2)] mb-1">Expires</label>
          <select v-model.number="expiresInDays" class="ui-input">
            <option :value="1">24 hours</option>
            <option :value="7">7 days</option>
            <option :value="30">30 days</option>
            <option :value="null">Never</option>
          </select>
        </div>

        <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)]">
          <input type="checkbox" v-model="useLimit" class="accent-accent" /> Limit downloads
        </label>
        <input v-if="useLimit" v-model.number="maxDownloads" type="number" min="1" class="ui-input" />

        <p v-if="error" class="text-[var(--c-danger)] text-xs">{{ error }}</p>
        <div class="flex gap-2 pt-1">
          <button @click="create" :disabled="busy" class="btn btn-primary btn-sm">
            {{ busy ? 'Creating…' : 'Create link' }}
          </button>
          <button @click="emit('close')" class="btn btn-ghost btn-sm">Cancel</button>
        </div>
      </template>

      <template v-else>
        <p class="text-xs text-[var(--c-text-3)]">Anyone with this link can access it.</p>
        <div class="flex gap-2">
          <input :value="url" readonly class="ui-input font-mono text-xs" />
          <button @click="copy" class="btn btn-outline btn-sm shrink-0">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <button @click="emit('close')" class="btn btn-ghost btn-sm">Done</button>
      </template>
    </div>
  </Modal>
</template>
