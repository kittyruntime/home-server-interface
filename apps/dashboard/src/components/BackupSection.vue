<script setup lang="ts">
import { LOADING } from '../lib/loading'
import BusyLabel from './ui/BusyLabel.vue'
import { computed, ref } from 'vue'
import { useAuth } from '../lib/auth'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import { useConfirm } from '../lib/confirm'
import { backupLine, contentsLine, FOLLOW_UPS, type BackupContents, type BackupInfo } from './backup/restore-preview'

const { token } = useAuth()
const password = ref('')
const confirmation = ref('')
const exporting = ref(false)
const error = ref<string | null>(null)
const complete = ref(false)
const restoreFile = ref<File | null>(null)
const restorePassword = ref('')
const restoring = ref(false)
const restoreError = ref<string | null>(null)
const restoreStep = ref<'checking' | 'uploading' | 'restarting' | 'reconnecting' | null>(null)
type Preview = { token: string; format: 1 | 2; backup: BackupInfo; contents: BackupContents
  conflicts: Array<{ kind: string; name: string; detail: string; command: string }>; warnings: string[] }
const preview = ref<Preview | null>(null)

// What a restore leaves to do, shown after the restart until dismissed.
const FOLLOW_UPS_KEY = 'hsi-restore-follow-ups'
const followUps = ref((() => { try { return localStorage.getItem(FOLLOW_UPS_KEY) === '1' } catch { return false } })())
function dismissFollowUps() {
  followUps.value = false
  try { localStorage.removeItem(FOLLOW_UPS_KEY) } catch { /* private mode */ }
}
const { confirm } = useConfirm()

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

function selectRestoreFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  restoreFile.value = file
  restoreError.value = file && file.size > 256 * 1024 * 1024 ? 'Backup files are limited to 256 MiB.' : null
}

function encodePassword(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function resetPreview() {
  const t = preview.value?.token
  preview.value = null
  // The server drops the decrypted backup at once.
  if (t && token.value) {
    void fetch('/system/config-restore/cancel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t }),
    }).catch(() => {})
  }
}

async function checkBackup() {
  if (!restoreFile.value || restorePassword.value.length < 16 || !token.value || restoreFile.value.size > 256 * 1024 * 1024) return
  restoring.value = true
  restoreError.value = null
  preview.value = null
  restoreStep.value = 'checking'
  try {
    const response = await fetch('/system/config-restore/preview', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.value}`,
        'Content-Type': 'application/vnd.hsi.config-backup',
        'X-HSI-Backup-Password': encodePassword(restorePassword.value),
      },
      body: restoreFile.value,
    })
    const body = await response.json().catch(() => null) as (Preview & { error?: string }) | null
    if (!response.ok || !body) throw new Error(body?.error ?? `Check failed (${response.status})`)
    preview.value = body
  } catch (cause: unknown) {
    restoreError.value = (cause as { message?: string })?.message ?? 'The backup could not be read'
  } finally {
    restoreStep.value = null
    restoring.value = false
  }
}

async function restoreBackup() {
  const p = preview.value
  if (!p || p.conflicts.length || !token.value) return
  const confirmed = await confirm(
    'Replace the current HSI configuration with this backup and restart HSI? Volumes stay as they are, and apps come back stopped.',
    { title: 'Restore configuration', confirmLabel: 'Restore and restart', danger: true },
  )
  if (!confirmed) return

  restoring.value = true
  restoreError.value = null
  restoreStep.value = 'uploading'
  try {
    const response = await fetch('/system/config-restore/apply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: p.token }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(body?.error ?? `Restore failed (${response.status})`)
    }
    restorePassword.value = ''
    if (p.format === 2) { try { localStorage.setItem(FOLLOW_UPS_KEY, '1') } catch { /* private mode */ } }
    restoreStep.value = 'restarting'
    pollRestoreRestart()
  } catch (cause: unknown) {
    restoreError.value = (cause as { message?: string })?.message ?? 'Configuration restore failed'
    preview.value = null
    restoreStep.value = null
    restoring.value = false
  }
}

function pollRestoreRestart() {
  let wentDown = false
  const interval = window.setInterval(async () => {
    try {
      const response = await fetch('/health', { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw new Error('not ready')
      if (wentDown) {
        window.clearInterval(interval)
        window.location.reload()
      }
    } catch {
      wentDown = true
      restoreStep.value = 'reconnecting'
    }
  }, 2000)
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

    <div class="panel-card mt-5 overflow-hidden border-[var(--c-danger)]/20">
      <div class="border-b border-[var(--c-border)] p-5">
        <p class="text-sm font-medium text-[var(--c-text-1)]">Restore configuration</p>
        <p class="mt-1 text-xs leading-5 text-[var(--c-text-3)]">Validate and restore an HSI configuration backup. The active database is retained on the server as a pre-restore rollback copy.</p>
      </div>
      <div v-if="followUps" class="border-b border-[var(--c-border)] bg-[var(--c-accent)]/5 p-5 space-y-2">
        <p class="text-sm font-medium text-[var(--c-text-1)]">The configuration was restored. Left to do:</p>
        <ul class="space-y-1.5">
          <li v-for="f in FOLLOW_UPS" :key="f.href" class="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--c-text-2)]">
            <span>{{ f.text }}</span><a :href="f.href" class="btn btn-outline btn-xs shrink-0">{{ f.label }}</a>
          </li>
        </ul>
        <div class="flex justify-end"><button type="button" class="btn btn-ghost btn-xs" @click="dismissFollowUps">Done</button></div>
      </div>
      <form class="space-y-4 p-5" @submit.prevent="preview ? restoreBackup() : checkBackup()">
        <div class="rounded-lg border border-[var(--c-danger)]/25 bg-[var(--c-danger)]/5 p-3 text-xs leading-5 text-[var(--c-text-2)]">
          Restoring replaces accounts, permissions, shares, application definitions, settings, metrics, and audit history, and restores the Linux accounts with their ids, the apps (stopped) and the volume descriptions. HSI restarts automatically. Disks, volumes, user files and Docker volume contents are not modified, and Samba passwords must be set again.
        </div>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-[var(--c-text-2)]">Backup file</span>
          <input type="file" accept=".hsibak,application/vnd.hsi.config-backup" class="block w-full text-xs text-[var(--c-text-3)] file:mr-3 file:rounded-lg file:border file:border-[var(--c-border)] file:bg-[var(--c-surface-deep)] file:px-3 file:py-2 file:text-xs file:text-[var(--c-text-2)]" required @change="selectRestoreFile($event); resetPreview()">
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-[var(--c-text-2)]">Backup password</span>
          <input v-model="restorePassword" type="password" @input="resetPreview" autocomplete="current-password" minlength="16" maxlength="1024" class="ui-input" placeholder="Password used during export" required>
        </label>
        <div v-if="restoreStep" class="flex items-center gap-2 text-xs text-[var(--c-accent)]">
          <LoadingSpinner />
          <span>{{ restoreStep === 'checking' ? 'Checking the backup…' : restoreStep === 'uploading' ? 'Restoring…' : restoreStep === 'restarting' ? 'Restarting HSI…' : 'Waiting for HSI to come back online…' }}</span>
        </div>
        <div v-if="preview" class="space-y-2 rounded-lg border border-[var(--c-border)] p-3 text-xs">
          <p class="font-medium text-[var(--c-text-1)]">{{ backupLine(preview.backup, preview.format) }}</p>
          <p class="text-[var(--c-text-2)]">{{ contentsLine(preview.contents) }}</p>
          <p v-for="c in preview.conflicts" :key="c.kind + c.name" role="alert" class="status-text text-danger">
            <span class="status-tag">[ERR]</span> {{ c.detail }}. On the server: <code class="font-mono">{{ c.command }}</code>
          </p>
          <p v-for="(w, i) in preview.warnings" :key="i" class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ w }}</p>
          <p v-if="preview.conflicts.length" class="text-[var(--c-text-3)]">Resolve the conflicts, then check the backup again.</p>
        </div>
        <p v-if="restoreError" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ restoreError }}</p>
        <div class="flex justify-end">
          <button v-if="!preview" class="btn btn-outline btn-sm" :disabled="!restoreFile || restorePassword.length < 16 || restoring">
            <BusyLabel :busy="restoring" busy-label="Checking">Check the backup</BusyLabel>
          </button>
          <template v-else>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="restoring" @click="resetPreview">Cancel</button>
            <button class="btn btn-danger btn-sm ml-2" :disabled="restoring || preview.conflicts.length > 0">
              <BusyLabel :busy="restoring" busy-label="Restoring">Restore…</BusyLabel>
            </button>
          </template>
        </div>
      </form>
    </div>
  </div>
</template>
