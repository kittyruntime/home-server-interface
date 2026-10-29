<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { useDockerStatus } from '../../lib/docker'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

/* Full-panel notice shown instead of the apps list / App Store while Docker is
   not usable on the server. */
const { status, checking, check } = useDockerStatus()

const title = computed(() => {
  const s = status.value
  if (!s?.installed) return 'Docker is not installed'
  if (!s.running) return 'Docker is not running'
  return 'Docker Compose is missing'
})

const command = computed(() => {
  const s = status.value
  if (!s?.installed) return 'sudo apt install docker.io docker-compose-v2'
  if (!s.running) return 'sudo systemctl enable --now docker'
  return 'sudo apt install docker-compose-v2'
})
</script>

<template>
  <div class="flex h-full w-full items-center justify-center p-6">
    <div class="w-full max-w-lg rounded-xl border border-warning/30 bg-card p-6 text-center">
      <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-warning/10 text-warning">
        <TriangleAlertIcon class="h-5 w-5" aria-hidden="true" />
      </div>
      <h2 class="text-base font-semibold text-foreground">{{ title }}</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        {{ t('ui.apps.DockerUnavailable.appsAndTheAppStore') }}
      </p>
      <code class="mt-3 block rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground select-all break-all">{{ command }}</code>
      <p v-if="status?.detail" class="mt-2 text-2xs text-muted-foreground break-words">{{ status.detail }}</p>
      <p class="mt-3 text-2xs text-muted-foreground">
        {{ t('ui.apps.DockerUnavailable.otherInstallOptions') }}
        <a href="https://docs.docker.com/engine/install/ubuntu/" target="_blank" rel="noopener" class="underline decoration-dotted underline-offset-2 hover:text-foreground">{{ t('ui.apps.DockerUnavailable.dockerSInstructionsForUbuntu') }}</a>
      </p>
      <Button size="sm" type="button" class="mt-4" :disabled="checking" @click="check">
        {{ checking ? 'Checking…' : 'Check again' }}
      </Button>
    </div>
  </div>
</template>
