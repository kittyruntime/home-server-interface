<script setup lang="ts">
import { LOADING } from '../lib/loading'
import BusyLabel from './ui/BusyLabel.vue'
import { computed, ref } from 'vue'
import { useAuth } from '../lib/auth'
import RestoreForm from './backup/RestoreForm.vue'

const { token } = useAuth()
const password = ref('')
const confirmation = ref('')
const exporting = ref(false)
const error = ref<string | null>(null)
const complete = ref(false)

const valid = computed(() => password.value.length >= 16 && password.value === confirmation.value)

async function downloadBackup() {
  if (!valid.value || !token.value) return
  exporting.value = true
  complete.value = false
  error.value = null
  try {
    const response = await fetch('/system/config-backup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? `Export failed (${response.status})`)
    }
    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') ?? ''
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'hsi-config.hsibak'
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
    password.value = ''
    confirmation.value = ''
    complete.value = true
  } catch (cause: unknown) {
    error.value = (cause as { message?: string })?.message ?? 'Configuration export failed'
  } finally {
    exporting.value = false
  }
}

</script>

<template>
  <div>
    <h2 class="mb-1 text-lg font-semibold text-[var(--c-text-1)]">Backup & restore</h2>
    <p class="mb-6 text-sm text-[var(--c-text-3)]">Export or restore an encrypted copy of the HSI configuration.</p>

    <div class="panel-card overflow-hidden">
      <div class="border-b border-[var(--c-border)] p-5">
        <p class="text-sm font-medium text-[var(--c-text-1)]">Configuration backup</p>
        <p class="mt-1 text-xs leading-5 text-[var(--c-text-3)]">Includes accounts, permissions, Places, shares, application definitions, settings, metrics, and audit history. Files stored in Places and Docker volume contents are not included.</p>
      </div>
      <form class="space-y-4 p-5" @submit.prevent="downloadBackup">
        <div class="rounded-lg border border-[var(--c-warning)]/25 bg-[var(--c-warning)]/5 p-3 text-xs leading-5 text-[var(--c-text-2)]">
          This export contains password hashes and container secrets. It is encrypted before download. Keep the password safe: HSI does not store it and cannot recover it.
        </div>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-[var(--c-text-2)]">Encryption password</span>
          <input v-model="password" type="password" autocomplete="new-password" minlength="16" maxlength="1024" class="ui-input" placeholder="At least 16 characters" required>
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-[var(--c-text-2)]">Confirm password</span>
          <input v-model="confirmation" type="password" autocomplete="new-password" minlength="16" maxlength="1024" class="ui-input" placeholder="Repeat the password" required>
        </label>
        <p v-if="confirmation && password !== confirmation" class="text-xs text-[var(--c-danger)]">Passwords do not match.</p>
        <p v-if="error" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>
        <p v-if="complete" class="text-xs text-[var(--c-success)]">Encrypted configuration backup downloaded.</p>
        <div class="flex justify-end">
          <button class="btn btn-primary btn-sm" :disabled="!valid || exporting">
            <BusyLabel :busy="exporting" :busy-label="LOADING.encrypting">Export configuration</BusyLabel>
          </button>
        </div>
      </form>
    </div>

    <RestoreForm :auth-token="token" />
  </div>
</template>
