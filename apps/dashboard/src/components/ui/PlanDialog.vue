<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import Modal from './Modal.vue'
import LoadingSpinner from './LoadingSpinner.vue'
import { trpc } from '../../lib/trpc'
import { planRequest, type PlanPreview, type PlanApply, type PlanStep, type AppOp, type StorageOp } from '../../lib/plan'

// Review then apply an operation plan (#36): the exact files, commands and
// devices HSI is about to touch, and the result of each step.

const modal = ref<InstanceType<typeof Modal> | null>(null)
const preview = ref<PlanPreview | null>(null)
const loading = ref(false)
const loadError = ref('')
const applying = ref(false)
const applied = ref<PlanApply | null>(null)
const stale = ref(false)
const applyError = ref('')
let settled = false

async function load() {
  const req = planRequest.value
  if (!req) return
  loading.value = true
  loadError.value = ''
  stale.value = false
  applied.value = null
  applyError.value = ''
  try {
    preview.value = req.domain === 'apps'
      ? await trpc.apps.plan.mutate({ op: req.op as AppOp, input: req.input })
      : await trpc.storage.plan.mutate({ op: req.op as StorageOp, input: req.input })
  } catch (e) {
    preview.value = null
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(() => planRequest.value?.id, id => {
  settled = false
  if (id !== undefined) void load()
}, { immediate: true })

const steps = computed<PlanStep[]>(() => applied.value?.steps ?? preview.value?.steps ?? [])
const destructiveSteps = computed(() => steps.value.filter(s => s.destructive))
const destructiveDevices = computed(() => {
  const seen = new Map<string, NonNullable<PlanStep['device']>>()
  for (const s of destructiveSteps.value) {
    for (const d of s.devices?.length ? s.devices : s.device ? [s.device] : []) {
      if (!seen.has(d.path)) seen.set(d.path, d)
    }
  }
  return [...seen.values()]
})

function resultOf(i: number) {
  return applied.value?.results[i]
}

function settle(outcome: Parameters<NonNullable<typeof planRequest.value>['resolve']>[0]) {
  if (settled) return
  settled = true
  planRequest.value?.resolve(outcome)
}

async function apply() {
  const req = planRequest.value
  if (!req || !preview.value || applying.value) return
  applying.value = true
  applyError.value = ''
  try {
    const fingerprint = preview.value.fingerprint
    const res: PlanApply = req.domain === 'apps'
      ? await trpc.apps.apply.mutate({ op: req.op as AppOp, input: req.input, fingerprint })
      : await trpc.storage.apply.mutate({ op: req.op as StorageOp, input: req.input, fingerprint })
    applied.value = res
    if (res.ok) {
      settle({ status: 'applied', result: res })
      // Warnings stay on screen (e.g. mdadm.conf not updated); otherwise the
      // dialog closes. `applying` must be false first: the Modal refuses to
      // close while an operation runs.
      if (!res.warnings?.length) {
        applying.value = false
        await nextTick()
        modal.value?.requestClose()
      }
    }
  } catch (e) {
    const err = e as { message?: string; data?: { code?: string } }
    if (err.data?.code === 'CONFLICT') stale.value = true
    else applyError.value = err.message ?? 'The operation failed'
  } finally {
    applying.value = false
  }
}

function onClose() {
  if (applied.value && !applied.value.ok) settle({ status: 'failed', error: applied.value.error ?? 'A step failed' })
  else if (applyError.value) settle({ status: 'failed', error: applyError.value })
  else settle({ status: 'cancelled' })
  planRequest.value = null
  preview.value = null
  applied.value = null
}

function fmtSize(n?: number): string {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n, i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

function deviceLine(d: NonNullable<PlanStep['device']>): string[] {
  return [d.model, d.serial, fmtSize(d.size), d.contents].filter((x): x is string => !!x)
}

const STATUS: Record<string, { label: string; cls: string }> = {
  'done':    { label: 'Done',    cls: 'text-success' },
  'started': { label: 'Started in the background', cls: 'text-[var(--c-info)]' },
  'warning': { label: 'Warning', cls: 'text-warning' },
  'skipped': { label: 'Skipped', cls: 'text-[var(--c-text-3)]' },
  'failed':  { label: 'Failed',  cls: 'text-danger' },
  'not-run': { label: 'Not run', cls: 'text-[var(--c-text-3)]' },
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-[var(--c-text-3)]'
  if (line.startsWith('@@')) return 'text-[var(--c-text-3)]'
  if (line.startsWith('+')) return 'text-success'
  if (line.startsWith('-')) return 'text-danger'
  return 'text-[var(--c-text-2)]'
}

const kindLabel: Record<string, string> = {
  create: 'Create', update: 'Edit file', delete: 'Delete file', run: 'Run', start: 'Start', stop: 'Stop', permissions: 'Permissions',
}

const done = computed(() => applied.value !== null)
const failedApply = computed(() => applied.value !== null && !applied.value.ok)
</script>

<template>
  <Modal
    v-if="planRequest"
    ref="modal"
    :key="planRequest.id"
    panel-class="w-full max-w-2xl"
    :prevent-close="applying"
    @close="onClose"
  >
    <template #header>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ planRequest.title }}</h3>
        <p class="text-xs text-[var(--c-text-3)] mt-0.5">
          {{ done ? 'What HSI did' : 'Review exactly what HSI will do on the server' }}
        </p>
      </div>
    </template>

    <div class="px-5 py-4 space-y-4">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-[var(--c-text-3)]">
        <LoadingSpinner label="" /> Preparing the plan…
      </div>

      <p v-else-if="loadError" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ loadError }}</p>

      <template v-else-if="steps.length">
        <!-- What will be erased: named, not hinted at. -->
        <section v-if="destructiveSteps.length && !done" class="rounded-lg border border-[var(--c-danger)]/40 px-4 py-3">
          <p class="text-sm font-medium text-danger">
            {{ destructiveSteps.length === 1 ? '1 step erases data' : `${destructiveSteps.length} steps erase data` }}
          </p>
          <ul class="mt-2 space-y-1">
            <li v-for="d in destructiveDevices" :key="d.path" class="text-xs text-[var(--c-text-2)]">
              <span class="font-mono text-[var(--c-text-1)]">{{ d.path }}</span>
              <span v-for="(part, i) in deviceLine(d)" :key="i"> · <span :class="i === 1 ? 'font-mono' : ''">{{ part }}</span></span>
            </li>
          </ul>
        </section>

        <ol class="divide-y divide-[var(--c-border)] rounded-lg border border-[var(--c-border)]">
          <li v-for="(s, i) in steps" :key="i" class="px-4 py-3">
            <div class="flex items-start gap-3">
              <span class="mt-0.5 w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-[var(--c-text-3)]">{{ i + 1 }}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm text-[var(--c-text-1)]" :class="s.destructive ? 'text-danger' : ''">{{ s.summary }}</p>
                <p v-if="s.device && !s.destructive" class="mt-1 text-xs text-[var(--c-text-2)]">
                  <span class="font-mono text-[var(--c-text-1)]">{{ s.device.path }}</span>
                  <template v-if="s.device.model"> · <span class="font-mono">{{ s.device.model }}</span></template>
                  <template v-if="s.device.serial"> · <span class="font-mono">{{ s.device.serial }}</span></template>
                  <template v-if="s.device.size"> · {{ fmtSize(s.device.size) }}</template>
                </p>
                <p class="mt-0.5 text-[11px] text-[var(--c-text-3)]">
                  <span class="uppercase tracking-wide">{{ kindLabel[s.kind] ?? s.kind }}</span>
                  <span class="font-mono"> · {{ s.target }}</span>
                  <span v-if="s.onFailure === 'warn'"> · a failure here is reported, not fatal</span>
                  <span v-if="s.background"> · runs in the background, follow it in notifications</span>
                </p>

                <details v-if="s.command?.length" class="mt-2">
                  <summary class="cursor-pointer text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)]">Command</summary>
                  <pre class="mt-1 overflow-x-auto rounded-md bg-[var(--c-surface-deep)] px-3 py-2 font-mono text-[11px] text-[var(--c-text-1)]">{{ s.command.join(' ') }}</pre>
                </details>
                <details v-if="s.diff" class="mt-2" :open="s.kind === 'update' && !done">
                  <summary class="cursor-pointer text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)]">{{ s.kind === 'create' ? 'Content of' : 'Changes to' }} {{ s.target }}</summary>
                  <pre class="mt-1 overflow-x-auto rounded-md bg-[var(--c-surface-deep)] px-3 py-2 font-mono text-[11px] leading-relaxed"><span v-for="(line, j) in s.diff.split('\n')" :key="j" :class="diffLineClass(line)">{{ line }}
</span></pre>
                </details>
                <p v-else-if="s.deferred" class="mt-1 text-[11px] text-[var(--c-text-3)]">The exact change is computed when the step runs and shown here afterwards.</p>

                <p v-if="resultOf(i)?.error" class="status-text mt-2" :class="resultOf(i)?.status === 'failed' ? 'text-danger' : 'text-warning'">
                  <span class="status-tag">{{ resultOf(i)?.status === 'failed' ? '[ERR]' : '[WARN]' }}</span> {{ resultOf(i)?.error }}
                </p>
              </div>
              <span v-if="resultOf(i)" class="shrink-0 text-xs font-medium" :class="STATUS[resultOf(i)!.status]?.cls">
                {{ STATUS[resultOf(i)!.status]?.label ?? resultOf(i)!.status }}
              </span>
            </div>
          </li>
        </ol>

        <p v-if="stale" role="alert" class="status-text text-warning">
          <span class="status-tag">[WARN]</span> The server changed since this preview. Review the new plan before applying it.
        </p>
        <p v-if="applyError" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ applyError }}</p>
        <p v-if="failedApply" role="alert" class="status-text text-danger">
          <span class="status-tag">[ERR]</span> The operation stopped at a failed step; later steps did not run.
        </p>
      </template>
    </div>

    <template #footer>
      <div class="flex-1" />
      <template v-if="failedApply || done || (loadError && !loading)">
        <button class="btn btn-primary btn-sm" @click="modal?.requestClose()">Close</button>
      </template>
      <template v-else>
        <button class="btn btn-ghost btn-sm" :disabled="applying" @click="modal?.requestClose()">Back</button>
        <button v-if="stale" class="btn btn-outline btn-sm" :disabled="loading" @click="load">Review again</button>
        <button
          v-else
          :class="['btn btn-sm', destructiveSteps.length || planRequest.danger ? 'btn-danger' : 'btn-primary']"
          :disabled="loading || applying || !preview"
          @click="apply"
        >
          <LoadingSpinner v-if="applying" label="" class="h-3 w-3" />
          {{ applying ? 'Applying…' : planRequest.actionLabel || 'Apply' }}
        </button>
      </template>
    </template>
  </Modal>
</template>
