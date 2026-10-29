<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { CheckIcon, TriangleAlertIcon } from '@lucide/vue'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import { maintenance } from '../lib/maintenance'
import { MAINTENANCE_STEPS, maintenanceStepState, type MaintenanceStep } from '../lib/maintenance-step'

const { t } = useI18n()

// Covers the whole app while an update, a restart or a reboot runs (#132).
// An alert dialog that nothing closes: focus stays in it, the page under it is
// inert, Escape and clicks outside do nothing.

const title = computed(() => {
  if (maintenance.kind === 'update') return maintenance.target ? t('maintenance.titleUpdateTo', { version: maintenance.target }) : t('maintenance.titleUpdate')
  return maintenance.kind === 'reboot' ? t('maintenance.titleReboot') : t('maintenance.titleRestart')
})

function reload() {
  window.location.reload()
}

function stepLabel(step: MaintenanceStep): string {
  if (step === 'working') return maintenance.kind === 'update' ? t('maintenance.stepInstalling') : maintenance.kind === 'reboot' ? t('maintenance.stepRebooting') : t('maintenance.stepRestarting')
  return t(`maintenance.step.${step}`)
}
</script>

<template>
  <AlertDialog :open="maintenance.kind !== null">
    <AlertDialogContent
      class="inset-0 top-0 left-0 z-[100] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-0 p-6 shadow-none sm:max-w-none"
      @escape-key-down.prevent
    >
      <div class="w-full max-w-xl space-y-10">
        <div class="space-y-3">
          <AlertDialogTitle class="text-3xl font-semibold text-foreground sm:text-4xl">{{ title }}</AlertDialogTitle>
          <AlertDialogDescription class="text-base text-muted-foreground">{{ t('maintenance.hint') }}</AlertDialogDescription>
        </div>

        <ol class="space-y-6" aria-live="polite">
          <li v-for="step in MAINTENANCE_STEPS" :key="step" class="flex items-center gap-4">
            <span
              :class="[
                'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors',
                maintenanceStepState(maintenance.step, step) === 'done'   ? 'bg-success/15 text-success' :
                maintenanceStepState(maintenance.step, step) === 'active' ? 'bg-primary/10 text-primary' :
                'bg-accent text-muted-foreground'
              ]"
            >
              <CheckIcon v-if="maintenanceStepState(maintenance.step, step) === 'done'" class="size-5" aria-hidden="true" />
              <LoadingSpinner v-else-if="maintenanceStepState(maintenance.step, step) === 'active'" />
              <span v-else class="size-2 rounded-full bg-current" />
            </span>
            <span
              :class="[
                'text-xl transition-colors sm:text-2xl',
                maintenanceStepState(maintenance.step, step) === 'pending' ? 'text-muted-foreground' : 'text-foreground',
                maintenanceStepState(maintenance.step, step) === 'active' ? 'font-medium' : '',
              ]"
              :aria-current="maintenanceStepState(maintenance.step, step) === 'active' ? 'step' : undefined"
            >{{ stepLabel(step) }}</span>
          </li>
        </ol>

        <div v-if="maintenance.result" :class="['flex items-start gap-3 text-lg', maintenance.result.problem ? 'text-destructive' : 'text-foreground']">
          <TriangleAlertIcon v-if="maintenance.result.problem" class="mt-1 size-5 shrink-0" aria-hidden="true" />
          <p>{{ maintenance.result.text }}</p>
        </div>

        <p v-if="maintenance.countdown > 0" class="font-mono text-sm text-muted-foreground">
          {{ t('maintenance.reloadingIn', { seconds: maintenance.countdown }) }}
        </p>
        <Button v-else-if="maintenance.result?.problem" size="lg" @click="reload">{{ t('maintenance.reload') }}</Button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
</template>
