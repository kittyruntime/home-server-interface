<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import BusyLabel from '../ui/BusyLabel.vue'
import LoadingState from '../ui/LoadingState.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { formatDateTime } from '../../lib/format-date'
import { useToast } from '../../lib/toast'
import { ShieldBanIcon } from '@lucide/vue'
import type { SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()

type Settings = SharingService['settings']
const FIELDS = ['netbiosName', 'workgroup', 'minProtocol', 'encryption', 'discoveryWsd', 'discoveryMdns', 'autoBlock', 'blockThreshold', 'blockWindowMin', 'blockForMin'] as const
type Field = typeof FIELDS[number]

// The form edits a copy; `saved` is what the server holds, so a save keeps
// the fields on screen while the service restarts and reloads.
type Values = Pick<Settings, Field>
const pick = (s: Values): Values => Object.fromEntries(FIELDS.map(f => [f, s[f]])) as Values
const form = ref<Values | null>(null)
const saving = ref(false)
const error = ref('')
const saved = ref<Values | null>(null)

const patch = computed(() => {
  if (!saved.value || !form.value) return {}
  const out: Partial<Values> = {}
  for (const f of FIELDS) if (form.value[f] !== saved.value[f]) (out as Record<string, unknown>)[f] = form.value[f]
  return out
})
const dirty = computed(() => Object.keys(patch.value).length > 0)

// Fresh values from the server replace the fields unless the owner is editing them.
watch(() => props.service?.settings, s => {
  if (!s || dirty.value || saving.value) return
  saved.value = pick(s)
  form.value = pick(s)
}, { immediate: true })

function reset() {
  if (saved.value) form.value = { ...saved.value }
  error.value = ''
}

// Same rules as the server, checked as the owner types.
const reName = /^[A-Za-z0-9-]{0,15}$/
const LIMITS = { blockThreshold: [1, 100], blockWindowMin: [1, 1440], blockForMin: [1, 10080] } as const
type NumField = keyof typeof LIMITS
const NUM_FIELDS = Object.keys(LIMITS) as NumField[]
function badNumber(f: NumField): boolean {
  const v = form.value?.[f]
  const [lo, hi] = LIMITS[f]
  return typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi
}
const invalid = computed(() => {
  const f = form.value
  if (!f) return {}
  return {
    netbiosName: !reName.test(f.netbiosName),
    workgroup: !reName.test(f.workgroup),
    ...(f.autoBlock ? Object.fromEntries(NUM_FIELDS.map(n => [n, badNumber(n)])) : {}),
  } as Partial<Record<Field, boolean>>
})
const hasInvalid = computed(() => Object.values(invalid.value).some(Boolean))

const wsdMissing = computed(() => !props.service?.state?.wsdd)
const mdnsMissing = computed(() => !props.service?.state?.avahi)
// A switch for a tool the server lacks stays off, unless it is on and can be turned off.
const discovery = computed(() => [
  { field: 'discoveryWsd' as const, label: t('sharing.settings.wsd'), missing: wsdMissing.value,
    help: wsdMissing.value ? t('sharing.settings.wsdMissing') : t('sharing.settings.wsdHelp') },
  { field: 'discoveryMdns' as const, label: t('sharing.settings.mdns'), missing: mdnsMissing.value,
    help: mdnsMissing.value ? t('sharing.settings.mdnsMissing') : t('sharing.settings.mdnsHelp') },
].map(d => ({ ...d, locked: d.missing && !form.value?.[d.field] })))
const numbers = computed(() => [
  { field: 'blockThreshold' as const, label: t('sharing.settings.threshold'), unit: '' },
  { field: 'blockWindowMin' as const, label: t('sharing.settings.window'), unit: t('sharing.settings.minutes') },
  { field: 'blockForMin' as const, label: t('sharing.settings.blockFor'), unit: t('sharing.settings.minutes') },
])

async function save() {
  if (!dirty.value || hasInvalid.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await applyPlanned('smb.settings', patch.value, { domain: 'sharing', title: t('sharing.settings.savePlan'), actionLabel: t('sharing.settings.save') })
    saved.value = { ...form.value! }
    toast.success(t('sharing.settings.saved'))
    emit('changed')
  } catch (e) {
    error.value = (e as Error).message || t('sharing.errors.action')
  } finally {
    saving.value = false
  }
}

type Block = Awaited<ReturnType<typeof trpc.sharing.blocks.query>>[number]
const blocks = ref<Block[]>([])
const blocksLoaded = ref(false)
const unblocking = ref<string | null>(null)
async function loadBlocks() {
  try { blocks.value = await trpc.sharing.blocks.query() } catch { /* keep the last list */ }
  blocksLoaded.value = true
}
async function unblock(ip: string) {
  unblocking.value = ip
  try {
    await trpc.sharing.unblock.mutate({ ip })
    toast.success(t('sharing.settings.unblocked', { ip }))
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  }
  await loadBlocks()
  unblocking.value = null
}
// An address blocked while this page is open shows up on its own.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void loadBlocks()
  timer = setInterval(() => { if (!document.hidden && !unblocking.value) void loadBlocks() }, 10000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.settings.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.settings.subtitle') }}</p>
    </div>

    <form v-if="form" class="space-y-4" novalidate @submit.prevent="save">
      <Card class="gap-5 p-4 @2xl:p-5">
        <h3 class="eyebrow">{{ t('sharing.settings.network') }}</h3>
        <div class="grid gap-4 @xl:grid-cols-2">
          <label v-for="f in (['netbiosName', 'workgroup'] as const)" :key="f" class="block space-y-1.5">
            <span class="text-sm font-medium text-base-content">{{ t(`sharing.settings.${f}`) }}</span>
            <Input v-model="form[f]" maxlength="15" autocomplete="off" spellcheck="false" class="w-full font-mono"
              :placeholder="f === 'workgroup' ? 'WORKGROUP' : undefined" :aria-invalid="invalid[f] || undefined" />
            <span class="block text-xs" :class="invalid[f] ? 'text-error' : 'text-base-content/70'">
              {{ invalid[f] ? t('sharing.settings.nameInvalid') : t(`sharing.settings.${f === 'netbiosName' ? 'netbiosHelp' : 'workgroupHelp'}`) }}
            </span>
          </label>
        </div>
      </Card>

      <Card class="gap-4 p-4 @2xl:p-5">
        <h3 class="eyebrow">{{ t('sharing.settings.discovery') }}</h3>
        <ul class="divide-y divide-base-300/70">
          <li v-for="d in discovery" :key="d.field" class="py-3 first:pt-0 last:pb-0">
            <label class="flex items-center justify-between gap-4" :class="d.locked ? 'cursor-default' : 'cursor-pointer'">
              <span class="min-w-0">
                <span class="block text-sm text-base-content">{{ d.label }}</span>
                <span class="block text-xs text-base-content/70">{{ d.help }}</span>
              </span>
              <span v-if="d.locked" class="badge badge-ghost badge-sm shrink-0 whitespace-nowrap">{{ t('sharing.settings.notInstalled') }}</span>
              <Switch v-else v-model="form[d.field]" class="shrink-0" />
            </label>
          </li>
        </ul>
      </Card>

      <Card class="gap-5 p-4 @2xl:p-5">
        <h3 class="eyebrow">{{ t('sharing.settings.security') }}</h3>
        <div class="grid gap-4 @xl:grid-cols-2">
          <label class="block space-y-1.5">
            <span class="text-sm font-medium text-base-content">{{ t('sharing.settings.minProtocol') }}</span>
            <NativeSelect v-model="form.minProtocol" wrapper-class="w-full">
              <NativeSelectOption value="SMB2">{{ t('sharing.settings.smb2') }}</NativeSelectOption>
              <NativeSelectOption value="SMB3">{{ t('sharing.settings.smb3') }}</NativeSelectOption>
            </NativeSelect>
            <span class="block text-xs text-base-content/70">{{ t('sharing.settings.minProtocolHelp') }}</span>
          </label>
          <label class="block space-y-1.5">
            <span class="text-sm font-medium text-base-content">{{ t('sharing.settings.encryption') }}</span>
            <NativeSelect v-model="form.encryption" wrapper-class="w-full">
              <NativeSelectOption value="off">{{ t('sharing.settings.encOff') }}</NativeSelectOption>
              <NativeSelectOption value="desired">{{ t('sharing.settings.encDesired') }}</NativeSelectOption>
              <NativeSelectOption value="required">{{ t('sharing.settings.encRequired') }}</NativeSelectOption>
            </NativeSelect>
            <span class="block text-xs text-base-content/70">{{ t('sharing.settings.encryptionHelp') }}</span>
          </label>
        </div>
        <div class="space-y-3 border-t border-base-300 pt-4">
          <label class="flex cursor-pointer items-center justify-between gap-4">
            <span class="min-w-0">
              <span class="block text-sm text-base-content">{{ t('sharing.settings.autoBlock') }}</span>
              <span class="block text-xs text-base-content/70">{{ t('sharing.settings.autoBlockHelp') }}</span>
            </span>
            <Switch v-model="form.autoBlock" class="shrink-0" />
          </label>
          <div v-if="form.autoBlock" class="grid max-w-xl gap-3 @md:grid-cols-3">
            <label v-for="n in numbers" :key="n.field" class="block space-y-1.5">
              <span class="text-xs font-medium text-base-content/80">{{ n.label }}</span>
              <div class="relative">
                <Input v-model.number="form[n.field]" type="number" inputmode="numeric" :min="LIMITS[n.field][0]" :max="LIMITS[n.field][1]" step="1"
                  class="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none tabular-nums" :class="n.unit && 'pr-12'" :aria-invalid="invalid[n.field] || undefined" />
                <span v-if="n.unit" class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-base-content/60">{{ n.unit }}</span>
              </div>
              <span v-if="invalid[n.field]" class="block text-xs text-error">{{ t('sharing.settings.between', { lo: LIMITS[n.field][0], hi: LIMITS[n.field][1] }) }}</span>
            </label>
          </div>
        </div>
      </Card>

      <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>

      <div v-if="dirty" class="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 rounded-box border border-base-300 bg-base-100 px-4 py-3 shadow-sm">
        <span class="mr-auto text-sm text-base-content/80">{{ t('sharing.settings.unsaved') }}</span>
        <Button type="button" variant="ghost" size="sm" :disabled="saving" @click="reset">{{ t('sharing.detail.cancel') }}</Button>
        <Button type="submit" size="sm" :disabled="hasInvalid || saving">
          <BusyLabel :busy="saving">{{ t('sharing.settings.save') }}</BusyLabel>
        </Button>
      </div>
    </form>

    <Card class="gap-3 p-4 @2xl:p-5">
      <h3 class="eyebrow">{{ t('sharing.nfs.settingsTitle') }}</h3>
      <div class="flex items-start gap-3">
        <span class="mt-1.5 size-2 shrink-0 rounded-full" aria-hidden="true"
          :class="!service?.nfs?.installed ? 'bg-base-content/30' : service.nfs?.active ? 'bg-success' : 'bg-warning'" />
        <div class="min-w-0">
          <p class="text-sm text-base-content">{{ !service?.nfs?.installed ? t('sharing.nfs.notInstalled') : service.nfs?.active ? t('sharing.nfs.on') : t('sharing.nfs.off') }}</p>
          <p class="text-xs text-base-content/70">{{ service?.nfs?.installed ? t('sharing.nfs.settingsHelp') : t('sharing.nfs.missing') }}</p>
        </div>
      </div>
    </Card>

    <Card class="gap-3 p-4 @2xl:p-5">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="eyebrow">{{ t('sharing.settings.blocked') }}</h3>
        <span v-if="blocks.length" class="text-xs text-base-content/70 tabular-nums">{{ blocks.length }}</span>
      </div>
      <LoadingState v-if="!blocksLoaded" variant="compact" />
      <p v-else-if="blocks.length === 0" class="text-sm text-base-content/70">{{ t('sharing.settings.noBlocked') }}</p>
      <ul v-else class="divide-y divide-base-300/70">
        <li v-for="b in blocks" :key="b.ip" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <ShieldBanIcon class="size-4 shrink-0 text-error" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-sm text-base-content">{{ b.ip }}</p>
            <p class="text-xs text-base-content/70">
              {{ t('sharing.settings.until', { time: formatDateTime(b.until) }) }}<template v-if="b.mine"> · <span class="font-medium text-warning">{{ t('sharing.settings.yours') }}</span></template>
            </p>
          </div>
          <Button variant="outline" size="xs" class="shrink-0" :disabled="!!unblocking" @click="unblock(b.ip)">
            <BusyLabel :busy="unblocking === b.ip">{{ t('sharing.settings.unblock') }}</BusyLabel>
          </Button>
        </li>
      </ul>
    </Card>
  </div>
</template>
