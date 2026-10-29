<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { LOADING } from '../lib/loading'
import BusyLabel from './ui/BusyLabel.vue'
import { computed, ref } from 'vue'
import { useAuth } from '../lib/auth'
import RestoreForm from './backup/RestoreForm.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

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
    <h2 class="mb-1 text-lg font-semibold text-foreground">{{ t('ui.settings.BackupSection.backupRestore') }}</h2>
    <p class="mb-6 text-sm text-muted-foreground">{{ t('ui.settings.BackupSection.exportOrRestoreAnEncrypted') }}</p>

    <Card class="block gap-0 py-0 overflow-hidden">
      <div class="border-b border-border p-5">
        <p class="text-sm font-medium text-foreground">{{ t('ui.settings.BackupSection.configurationBackup') }}</p>
        <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t('ui.settings.BackupSection.includesAccountsPermissionsPlacesShares') }}</p>
      </div>
      <form class="space-y-4 p-5" @submit.prevent="downloadBackup">
        <Alert variant="warning" class="block p-3 text-xs leading-5 text-foreground/80" role="note">
          {{ t('ui.settings.BackupSection.thisExportContainsPasswordHashes') }}
        </Alert>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-foreground/80">{{ t('ui.settings.BackupSection.encryptionPassword') }}</span>
          <Input v-model="password" type="password" autocomplete="new-password" minlength="16" maxlength="1024" :placeholder="t('ui.settings.BackupSection.atLeast16Characters')" required />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-foreground/80">{{ t('ui.settings.BackupSection.confirmPassword') }}</span>
          <Input v-model="confirmation" type="password" autocomplete="new-password" minlength="16" maxlength="1024" :placeholder="t('ui.settings.BackupSection.repeatThePassword')" required />
        </label>
        <p v-if="confirmation && password !== confirmation" class="text-xs text-destructive">{{ t('ui.settings.BackupSection.passwordsDoNotMatch') }}</p>
        <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
        <p v-if="complete" class="text-xs text-success">{{ t('ui.settings.BackupSection.encryptedConfigurationBackupDownloaded') }}</p>
        <div class="flex justify-end">
          <Button size="sm" :disabled="!valid || exporting">
            <BusyLabel :busy="exporting" :busy-label="LOADING.encrypting">{{ t('ui.settings.BackupSection.exportConfiguration') }}</BusyLabel>
          </Button>
        </div>
      </form>
    </Card>

    <RestoreForm :auth-token="token" />
  </div>
</template>
