<script setup lang="ts">
import { Alert } from '@/components/ui/alert'
import { ref } from 'vue'
import BusyLabel from '../ui/BusyLabel.vue'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import { useConfirm } from '../../lib/confirm'
import { backupLine, contentsLine, FOLLOW_UPS, type BackupContents, type BackupInfo } from './restore-preview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/* Restore a configuration backup (#1): check it, review the preview, restore.
   Used by Settings > Backup & restore (admin session) and by the first-run
   assistant (#12, its setup session). After the restart, `afterRestart` runs
   (default: reload the page). */
const props = withDefaults(defineProps<{ authToken: string | null; afterRestart?: () => void; showFollowUps?: boolean }>(), {
  afterRestart: () => window.location.reload(),
  showFollowUps: true,
})
const token = { get value() { return props.authToken } }

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
        props.afterRestart()
      }
    } catch {
      wentDown = true
      restoreStep.value = 'reconnecting'
    }
  }, 2000)
}
</script>

<template>
    <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden mt-5 overflow-hidden border-destructive/20">
      <div class="border-b border-border p-5">
        <p class="text-sm font-medium text-foreground">Restore configuration</p>
        <p class="mt-1 text-xs leading-5 text-muted-foreground">Validate and restore an HSI configuration backup. The active database is retained on the server as a pre-restore rollback copy.</p>
      </div>
      <div v-if="followUps && showFollowUps" class="border-b border-border bg-primary/5 p-5 space-y-2">
        <p class="text-sm font-medium text-foreground">The configuration was restored. Left to do:</p>
        <ul class="space-y-1.5">
          <li v-for="f in FOLLOW_UPS" :key="f.href" class="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground/80">
            <span>{{ f.text }}</span><Button as="a" variant="outline" size="xs" :href="f.href" class="shrink-0">{{ f.label }}</Button>
          </li>
        </ul>
        <div class="flex justify-end"><Button variant="ghost" size="xs" type="button" @click="dismissFollowUps">Done</Button></div>
      </div>
      <form class="space-y-4 p-5" @submit.prevent="preview ? restoreBackup() : checkBackup()">
        <Alert variant="destructive" class="block p-3 text-xs leading-5 text-foreground/80" role="note">
          Restoring replaces accounts, permissions, shares, application definitions, settings, metrics, and audit history, and restores the Linux accounts with their ids, the apps (stopped) and the volume descriptions. HSI restarts automatically. Disks, volumes, user files and Docker volume contents are not modified, and Samba passwords must be set again.
        </Alert>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-foreground/80">Backup file</span>
          <Input type="file" accept=".hsibak,application/vnd.hsi.config-backup" class="text-xs" required @change="selectRestoreFile($event); resetPreview()" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-foreground/80">Backup password</span>
          <Input v-model="restorePassword" type="password" @input="resetPreview" autocomplete="current-password" minlength="16" maxlength="1024" placeholder="Password used during export" required />
        </label>
        <div v-if="restoreStep" class="flex items-center gap-2 text-xs text-primary">
          <LoadingSpinner />
          <span>{{ restoreStep === 'checking' ? 'Checking the backup…' : restoreStep === 'uploading' ? 'Restoring…' : restoreStep === 'restarting' ? 'Restarting HSI…' : 'Waiting for HSI to come back online…' }}</span>
        </div>
        <div v-if="preview" class="space-y-2 rounded-lg border border-border p-3 text-xs">
          <p class="font-medium text-foreground">{{ backupLine(preview.backup, preview.format) }}</p>
          <p class="text-foreground/80">{{ contentsLine(preview.contents) }}</p>
          <p v-for="c in preview.conflicts" :key="c.kind + c.name" role="alert" class="status-text text-destructive">
            <span class="status-tag">[ERR]</span> {{ c.detail }}. On the server: <code class="font-mono">{{ c.command }}</code>
          </p>
          <p v-for="(w, i) in preview.warnings" :key="i" class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ w }}</p>
          <p v-if="preview.conflicts.length" class="text-muted-foreground">Resolve the conflicts, then check the backup again.</p>
        </div>
        <p v-if="restoreError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ restoreError }}</p>
        <div class="flex justify-end">
          <Button variant="outline" size="sm" v-if="!preview" :disabled="!restoreFile || restorePassword.length < 16 || restoring">
            <BusyLabel :busy="restoring" busy-label="Checking">Check the backup</BusyLabel>
          </Button>
          <template v-else>
            <Button variant="ghost" size="sm" type="button" :disabled="restoring" @click="resetPreview">Cancel</Button>
            <Button variant="destructive" size="sm" class="ml-2" :disabled="restoring || preview.conflicts.length > 0">
              <BusyLabel :busy="restoring" busy-label="Restoring">Restore…</BusyLabel>
            </Button>
          </template>
        </div>
      </form>
    </div>
</template>
