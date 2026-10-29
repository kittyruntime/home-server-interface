<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon, HistoryIcon, PowerIcon, RefreshCwIcon } from '@lucide/vue'
import { formatDateTime, formatDay } from '../lib/format-date'
import { lastResultText, lastResultIsProblem, previousVersionText, rollbackCommand } from '../lib/update-result'
import LoadingState from './ui/LoadingState.vue'
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../lib/trpc'
import ReleaseNotes from './ReleaseNotes.vue'
import { useConfirm } from '../lib/confirm'
import { startMaintenance } from '../lib/maintenance'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

type Status = Awaited<ReturnType<typeof trpc.update.status.query>>
type Preflight = Awaited<ReturnType<typeof trpc.update.preflight.query>>

const status   = ref<Status | null>(null)
const preflight = ref<Preflight | null>(null)
const preflightLoading = ref(false)
const loading  = ref(true)
const applying = ref(false)
const checking = ref(false)
const error    = ref<string | null>(null)
const restarting = ref(false)
const rebooting = ref(false)
const { confirm } = useConfirm()

async function fetchStatus() {
  try {
    status.value = await trpc.update.status.query()
    error.value = null
    if (status.value.hasUpdate) fetchPreflight()
  } catch (e: any) {
    error.value = e?.message ?? t('uis.settings.UpdateSection.failedToFetchUpdateStatus')
  } finally {
    loading.value = false
  }
}

async function fetchPreflight() {
  preflightLoading.value = true
  try {
    preflight.value = await trpc.update.preflight.query()
  } catch {
    preflight.value = null
  } finally {
    preflightLoading.value = false
  }
}

async function checkNow() {
  checking.value = true
  error.value = null
  try {
    await trpc.update.check.mutate()
    await fetchStatus()
  } catch (e: any) {
    error.value = e?.message ?? t('uis.settings.UpdateSection.failedToCheckForUpdates')
  } finally {
    checking.value = false
  }
}

async function applyUpdate() {
  if (!status.value?.latest) return
  applying.value = true
  error.value = null
  try {
    await trpc.update.execute.mutate({ version: status.value.latest })
    startMaintenance('update', status.value.latest)
  } catch (e: any) {
    error.value = e?.message ?? t('uis.settings.UpdateSection.failedToScheduleUpdate')
    applying.value = false
  }
}

async function restartSoftware() {
  const accepted = await confirm(
    t('uis.settings.UpdateSection.restartHsiNowTheInterface'),
    { title: t('uis.settings.UpdateSection.restartHsi'), confirmLabel: t('uis.settings.UpdateSection.restartNow'), danger: true },
  )
  if (!accepted) return
  restarting.value = true
  error.value = null
  try {
    await trpc.update.restart.mutate()
    startMaintenance('restart')
  } catch (e: any) {
    error.value = e?.message ?? t('uis.settings.UpdateSection.failedToRestartHsi')
    restarting.value = false
  }
}

async function rebootHost() {
  const accepted = await confirm(
    t('uis.settings.UpdateSection.rebootTheEntireServerHsi'),
    { title: t('uis.settings.UpdateSection.rebootServer'), confirmLabel: t('uis.settings.UpdateSection.continue'), danger: true },
  )
  if (!accepted) return
  const confirmed = await confirm(
    t('uis.settings.UpdateSection.finalConfirmationRebootThePhysical'),
    { title: t('uis.settings.UpdateSection.confirmServerReboot'), confirmLabel: t('uis.settings.UpdateSection.rebootServer'), danger: true },
  )
  if (!confirmed) return
  rebooting.value = true
  error.value = null
  try {
    await trpc.update.rebootHost.mutate()
    startMaintenance('reboot')
  } catch (e: any) {
    error.value = e?.message ?? t('uis.settings.UpdateSection.failedToRebootTheServer')
    rebooting.value = false
  }
}

let timer: ReturnType<typeof setInterval>

onMounted(() => {
  fetchStatus()
  timer = setInterval(fetchStatus, 60_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.settings.UpdateSection.updates') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">{{ t('ui.settings.UpdateSection.manageSoftwareUpdatesForThis') }}</p>

    <LoadingState v-if="loading" variant="compact" />

    <!-- ── Error ────────────────────────────────────────────────────────── -->
    <Alert variant="destructive" v-else-if="error" class="mt-4"><AlertDescription>{{ error }}</AlertDescription></Alert>

    <!-- ── Main content ─────────────────────────────────────────────────── -->
    <div v-else-if="status" class="space-y-5">

      <!-- Version row -->
      <Card class="gap-0 py-0 overflow-hidden p-5 flex flex-row items-center justify-between gap-6">
        <div>
          <p class="eyebrow mb-1">{{ t('ui.settings.UpdateSection.currentVersion') }}</p>
          <p class="font-figure text-xl text-foreground">{{ status.current }}</p>
        </div>
        <template v-if="status.hasUpdate">
          <ArrowRightIcon class="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <div class="text-right">
            <p class="eyebrow mb-1">{{ t('ui.settings.UpdateSection.available') }}</p>
            <p class="font-figure text-xl text-primary">{{ status.latest }}</p>
          </div>
        </template>
        <template v-else>
          <div class="flex items-center gap-2 text-success">
            <CheckIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
            <span class="text-sm">{{ t('ui.settings.UpdateSection.upToDate') }}</span>
          </div>
        </template>
      </Card>

      <!-- Last update result and the version it left behind -->
      <Card v-if="lastResultText(status.lastResult) || previousVersionText(status.rollbackTarget, status.current, formatDay)" class="block gap-0 py-0 overflow-hidden p-5 space-y-2">
        <p v-if="status.lastResult && lastResultText(status.lastResult)"
           :class="['text-sm', status.lastResult.status === 'partial' ? 'text-warning' : lastResultIsProblem(status.lastResult) ? 'text-destructive' : 'text-foreground/80']">
          {{ lastResultText(status.lastResult) }}
          <span class="text-xs text-muted-foreground">{{ formatDateTime(status.lastResult.at) }}</span>
        </p>
        <div v-if="status.lastResult?.skippedSettings?.length" class="space-y-2 text-sm text-warning">
          <p>{{ t('ui.settings.UpdateSection.theUpdateIsCompleteThese') }}</p>
          <ul class="list-disc pl-5 space-y-2">
            <li v-for="(item, index) in status.lastResult.skippedSettings" :key="index">
              <strong>{{ item.application }} ({{ item.setting }})</strong>: {{ item.reason }}.
              {{ item.remediation }}
            </li>
          </ul>
        </div>
        <p v-if="previousVersionText(status.rollbackTarget, status.current, formatDay)" class="text-sm text-foreground/80">
          {{ previousVersionText(status.rollbackTarget, status.current, formatDay) }}
          <code class="font-mono text-xs text-foreground">{{ rollbackCommand(status.rollbackCommand) }}</code>
        </p>
      </Card>

      <!-- Release notes -->
      <Card v-if="status.hasUpdate && status.releaseNotes" class="block gap-0 py-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <p class="eyebrow">{{ t('uip.settings.UpdateSection.whatSNewIn', { p0: status.latest }) }}</p>
          <a
            :href="`${status.repoUrl}/releases/tag/${status.latest}`"
            target="_blank" rel="noopener noreferrer"
            class="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0"
          >
            {{ t('ui.settings.UpdateSection.viewOnGithub') }}
            <ExternalLinkIcon class="w-3 h-3" aria-hidden="true" />
          </a>
        </div>
        <div class="px-4 py-3 max-h-72 overflow-y-auto">
          <ReleaseNotes :source="status.releaseNotes" />
        </div>
      </Card>

      <!-- Pre-flight checks -->
      <Card v-if="status.hasUpdate && preflight" class="block gap-0 py-0 overflow-hidden">
        <div class="px-4 py-3 border-b border-border">
          <p class="eyebrow">{{ t('ui.settings.UpdateSection.preFlightChecks') }}</p>
        </div>
        <ul class="divide-y divide-border">
          <li v-for="c in preflight.checks" :key="c.id" class="px-4 py-2.5 flex items-center gap-3">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="c.status === 'ok' ? 'bg-success' : c.status === 'warn' ? 'bg-warning' : 'bg-destructive'"
            />
            <span class="text-sm text-foreground flex-1 min-w-0">{{ c.label }}</span>
            <span v-if="c.detail" class="text-xs text-muted-foreground truncate">{{ c.detail }}</span>
          </li>
        </ul>
      </Card>

      <!-- Install CTA -->
      <div v-if="status.hasUpdate" class="flex items-center justify-between gap-4">
        <p class="text-xs text-muted-foreground">
          <template v-if="preflight && !preflight.canApply">{{ t('ui.settings.UpdateSection.aPreFlightCheckIs') }}</template>
          <template v-else>{{ t('ui.settings.UpdateSection.theServerWillRestartAfter') }}</template>
        </p>
        <Button size="sm"
          @click="applyUpdate"
          :disabled="applying || status.pending || (preflight ? !preflight.canApply : false)"
          class="shrink-0"
        >
          <LoadingSpinner v-if="applying || status.pending" />
          {{ applying || status.pending ? 'Scheduling…' : 'Install update' }}
        </Button>
      </div>

      <!-- Footer: last checked + manual check -->
      <div class="flex items-center justify-between pt-1 border-t border-border">
        <div>
          <p class="text-xs text-muted-foreground">
            <template v-if="status.checkedAt">{{ t('uip.settings.UpdateSection.lastChecked', { p0: formatDateTime(status.checkedAt) }) }}</template>
            <template v-else>{{ t('ui.settings.UpdateSection.neverCheckedRunsDailyVia') }}</template>
          </p>
          <a
            :href="`${status.repoUrl}/releases`"
            target="_blank" rel="noopener noreferrer"
            class="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-0.5"
          >
            {{ t('ui.settings.UpdateSection.viewAllReleasesOnGithub') }}
            <ExternalLinkIcon class="w-3 h-3" aria-hidden="true" />
          </a>
        </div>
        <Button variant="outline" size="xs"
          @click="checkNow"
          :disabled="checking || applying || !!status.pending"
        >
          <LoadingSpinner v-if="checking" />
          <RefreshCwIcon v-else class="w-3 h-3" aria-hidden="true" />
          {{ checking ? 'Checking…' : 'Check now' }}
        </Button>
      </div>

      <Card class="gap-0 py-0 overflow-hidden p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-foreground">{{ t('ui.settings.UpdateSection.restartHsi') }}</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t('ui.settings.UpdateSection.restartTheApplicationBackendWithout') }}</p>
        </div>
        <Button variant="outline" size="sm"
          @click="restartSoftware"
          :disabled="restarting || applying || !!status.pending"
          class="shrink-0"
        >
          <LoadingSpinner v-if="restarting" />
          <HistoryIcon v-else class="w-3.5 h-3.5" aria-hidden="true" />
          {{ restarting ? 'Restarting…' : 'Restart HSI' }}
        </Button>
      </Card>

      <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 border-destructive/25 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-foreground">{{ t('ui.settings.UpdateSection.rebootServer') }}</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t('ui.settings.UpdateSection.restartThePhysicalHostAnd') }}</p>
        </div>
        <Button variant="destructive" size="sm"
          @click="rebootHost"
          :disabled="rebooting || restarting || applying || !!status.pending"
          class="shrink-0"
        >
          <LoadingSpinner v-if="rebooting" />
          <PowerIcon v-else class="w-3.5 h-3.5" aria-hidden="true" />
          {{ rebooting ? 'Rebooting…' : 'Reboot server' }}
        </Button>
      </div>

    </div>
  </div>
</template>
