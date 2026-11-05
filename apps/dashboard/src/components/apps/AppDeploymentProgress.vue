<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const { t } = useI18n()

defineProps<{
  name: string
  status: 'pending' | 'running' | 'failed' | 'completed'
  taskStatus: string
  action: string
  error: string
  canViewJobLogs: boolean
  canRetry: boolean
}>()

const emit = defineEmits<{
  retry: []
  edit: []
  close: []
  logs: []
  containerLogs: []
  continue: []
}>()
</script>

<template>
  <section class="mx-auto w-full max-w-3xl p-4 sm:p-8" aria-labelledby="deployment-title">
    <div class="rounded-xl border border-base-300 bg-base-100 p-5 sm:p-7 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs font-semibold uppercase tracking-wide text-base-content/60">{{ t('ui.apps.AppDeploymentProgress.deployment') }}</p>
          <h2 id="deployment-title" class="mt-1 break-words text-xl font-semibold">{{ name }}</h2>
          <p class="mt-2 text-sm text-base-content/70">
            {{ t('ui.apps.AppDeploymentProgress.configurationSaved') }}
          </p>
        </div>
        <Badge :variant="status === 'failed' ? 'destructive' : status === 'completed' ? 'secondary' : 'outline'" class="shrink-0">
          {{ t(`ui.apps.AppDeploymentProgress.badge.${status}`) }}
        </Badge>
      </div>

      <div class="mt-7 rounded-lg bg-base-200/70 p-4" role="status" aria-live="polite">
        <div class="flex items-center gap-3">
          <span v-if="status === 'pending' || status === 'running'" class="loading loading-spinner loading-sm text-primary" aria-hidden="true" />
          <span v-else-if="status === 'completed'" class="text-success" aria-hidden="true">✓</span>
          <span v-else class="text-error" aria-hidden="true">!</span>
          <div class="min-w-0">
            <p class="font-medium">
              {{ status === 'pending' && taskStatus === 'running' ? t('ui.apps.AppDeploymentProgress.heading.stillRunning') : t(`ui.apps.AppDeploymentProgress.heading.${status}`) }}
            </p>
            <p class="mt-1 break-words text-xs text-base-content/70">
              {{ t('ui.apps.AppDeploymentProgress.taskStatus', { p0: taskStatus || status }) }}
            </p>
          </div>
        </div>
        <progress v-if="status === 'pending' || status === 'running'" class="progress progress-primary mt-4 w-full" :aria-label="t('ui.apps.AppDeploymentProgress.inProgress')" />
      </div>

      <div v-if="error" class="alert mt-4" :class="status === 'failed' ? 'alert-error' : 'alert-info'" :role="status === 'failed' ? 'alert' : 'status'">
        <span class="break-words">{{ error }}</span>
      </div>
      <p v-else-if="status === 'completed'" class="mt-4 text-sm text-success">
        {{ t('ui.apps.AppDeploymentProgress.completedDetail') }}
      </p>
      <p v-else-if="status === 'pending'" class="mt-4 text-sm text-base-content/70">
        {{ t('ui.apps.AppDeploymentProgress.pendingDetail') }}
      </p>

      <div class="mt-7 flex flex-wrap justify-end gap-2">
        <Button v-if="canViewJobLogs" variant="outline" @click="emit('logs')">{{ t('ui.apps.AppDeploymentProgress.viewTaskLogs') }}</Button>
        <Button v-if="status === 'pending'" variant="outline" @click="emit('continue')">{{ t('ui.apps.AppDeploymentProgress.keepWaiting') }}</Button>
        <Button v-if="status === 'failed' && canRetry" variant="outline" @click="emit('retry')">{{ t('ui.apps.AppDeploymentProgress.retry') }}</Button>
        <Button v-if="status === 'failed' || status === 'completed'" variant="outline" @click="emit('edit')">{{ t('ui.apps.AppDeploymentProgress.edit') }}</Button>
        <Button v-if="status === 'completed'" variant="outline" @click="emit('containerLogs')">{{ t('ui.apps.AppDeploymentProgress.viewContainerLogs') }}</Button>
        <Button @click="emit('close')">{{ t('ui.apps.AppDeploymentProgress.viewContainers') }}</Button>
      </div>
    </div>
  </section>
</template>
