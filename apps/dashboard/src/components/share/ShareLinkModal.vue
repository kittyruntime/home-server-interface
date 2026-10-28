<script setup lang="ts">
import { ref } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

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
  } catch { /* clipboard unavailable (non-secure context); the URL stays selectable in the field */ }
}
</script>

<template>
  <Modal panel-class="w-full max-w-md" :show-close="false" @close="emit('close')">
    <div class="p-6 space-y-4">
      <h3 class="text-base font-semibold text-foreground">Share "{{ name }}"</h3>

      <template v-if="!url">
        <label class="flex items-center gap-2 text-sm text-foreground/80">
          <input type="checkbox" v-model="usePassword" class="accent-primary" /> Password protect
        </label>
        <Input v-if="usePassword" v-model="password" type="password" placeholder="Password" />

        <div>
          <label class="block text-xs text-foreground/80 mb-1">Expires</label>
          <NativeSelect v-model.number="expiresInDays">
            <NativeSelectOption :value="1">24 hours</NativeSelectOption>
            <NativeSelectOption :value="7">7 days</NativeSelectOption>
            <NativeSelectOption :value="30">30 days</NativeSelectOption>
            <NativeSelectOption :value="null">Never</NativeSelectOption>
          </NativeSelect>
        </div>

        <label class="flex items-center gap-2 text-sm text-foreground/80">
          <input type="checkbox" v-model="useLimit" class="accent-primary" /> Limit downloads
        </label>
        <Input v-if="useLimit" v-model.number="maxDownloads" type="number" min="1" />

        <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
        <div class="flex gap-2 pt-1">
          <Button size="sm" @click="create" :disabled="busy">
            {{ busy ? 'Creating…' : 'Create link' }}
          </Button>
          <Button variant="ghost" size="sm" @click="emit('close')">Cancel</Button>
        </div>
      </template>

      <template v-else>
        <p class="text-xs text-muted-foreground">Anyone with this link can access it.</p>
        <div class="flex gap-2">
          <Input :value="url" readonly class="font-mono text-xs" />
          <Button variant="outline" size="sm" @click="copy" class="shrink-0">{{ copied ? 'Copied' : 'Copy' }}</Button>
        </div>
        <Button variant="ghost" size="sm" @click="emit('close')">Done</Button>
      </template>
    </div>
  </Modal>
</template>
