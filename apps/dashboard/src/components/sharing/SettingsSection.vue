<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { formatDateTime } from '../../lib/format-date'
import { useToast } from '../../lib/toast'
import type { SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()

type Settings = SharingService['settings']
const FIELDS = ['netbiosName', 'workgroup', 'minProtocol', 'encryption', 'discoveryWsd', 'discoveryMdns', 'autoBlock', 'blockThreshold', 'blockWindowMin', 'blockForMin'] as const
type Field = typeof FIELDS[number]

const form = ref<Pick<Settings, Field> | null>(null)
watch(() => props.service?.settings, s => {
  if (s && !form.value) form.value = Object.fromEntries(FIELDS.map(f => [f, s[f]])) as Pick<Settings, Field>
}, { immediate: true })

const patch = computed(() => {
  const s = props.service?.settings
  if (!s || !form.value) return {}
  const out: Partial<Pick<Settings, Field>> = {}
  for (const f of FIELDS) if (form.value[f] !== s[f]) (out as Record<string, unknown>)[f] = form.value[f]
  return out
})
const dirty = computed(() => Object.keys(patch.value).length > 0)

const wsdMissing = computed(() => !props.service?.state?.wsdd)
const mdnsMissing = computed(() => !props.service?.state?.avahi)

const saving = ref(false)
const error = ref('')
async function save() {
  saving.value = true
  error.value = ''
  try {
    await applyPlanned('smb.settings', patch.value, { domain: 'sharing', title: t('sharing.settings.savePlan'), actionLabel: t('sharing.settings.save') })
    toast.success(t('sharing.settings.saved'))
    form.value = null
    emit('changed')
  } catch (e) {
    error.value = (e as Error).message || t('sharing.errors.action')
  } finally {
    saving.value = false
  }
}

type Block = Awaited<ReturnType<typeof trpc.sharing.blocks.query>>[number]
const blocks = ref<Block[]>([])
async function loadBlocks() {
  try { blocks.value = await trpc.sharing.blocks.query() } catch { blocks.value = [] }
}
async function unblock(ip: string) {
  try {
    await trpc.sharing.unblock.mutate({ ip })
    toast.success(t('sharing.settings.unblocked', { ip }))
  } catch (e) {
    toast.error((e as Error).message || t('sharing.errors.action'))
  }
  await loadBlocks()
}
onMounted(loadBlocks)
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.settings.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.settings.subtitle') }}</p>
    </div>

    <form v-if="form" class="space-y-4" @submit.prevent="save">
      <Card class="space-y-4 p-4">
        <h3 class="eyebrow">{{ t('sharing.settings.network') }}</h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="space-y-1">
            <span class="text-sm text-base-content">{{ t('sharing.settings.netbiosName') }}</span>
            <Input v-model="form.netbiosName" maxlength="15" pattern="[A-Za-z0-9-]*" class="w-full font-mono" />
            <span class="block text-xs text-base-content/70">{{ t('sharing.settings.netbiosHelp') }}</span>
          </label>
          <label class="space-y-1">
            <span class="text-sm text-base-content">{{ t('sharing.settings.workgroup') }}</span>
            <Input v-model="form.workgroup" maxlength="15" pattern="[A-Za-z0-9-]*" class="w-full font-mono" />
            <span class="block text-xs text-base-content/70">{{ t('sharing.settings.workgroupHelp') }}</span>
          </label>
        </div>
        <h3 class="eyebrow pt-2">{{ t('sharing.settings.discovery') }}</h3>
        <label class="flex items-start gap-3 text-sm">
          <Switch v-model="form.discoveryWsd" :disabled="wsdMissing && !form.discoveryWsd" />
          <span>{{ t('sharing.settings.wsd') }}<span v-if="wsdMissing" class="block text-xs text-base-content/70">{{ t('sharing.settings.wsdMissing') }}</span></span>
        </label>
        <label class="flex items-start gap-3 text-sm">
          <Switch v-model="form.discoveryMdns" :disabled="mdnsMissing && !form.discoveryMdns" />
          <span>{{ t('sharing.settings.mdns') }}<span v-if="mdnsMissing" class="block text-xs text-base-content/70">{{ t('sharing.settings.mdnsMissing') }}</span></span>
        </label>
      </Card>

      <Card class="space-y-4 p-4">
        <h3 class="eyebrow">{{ t('sharing.settings.security') }}</h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="space-y-1">
            <span class="text-sm text-base-content">{{ t('sharing.settings.minProtocol') }}</span>
            <NativeSelect v-model="form.minProtocol" wrapper-class="w-full">
              <NativeSelectOption value="SMB2">{{ t('sharing.settings.smb2') }}</NativeSelectOption>
              <NativeSelectOption value="SMB3">{{ t('sharing.settings.smb3') }}</NativeSelectOption>
            </NativeSelect>
          </label>
          <label class="space-y-1">
            <span class="text-sm text-base-content">{{ t('sharing.settings.encryption') }}</span>
            <NativeSelect v-model="form.encryption" wrapper-class="w-full">
              <NativeSelectOption value="off">{{ t('sharing.settings.encOff') }}</NativeSelectOption>
              <NativeSelectOption value="desired">{{ t('sharing.settings.encDesired') }}</NativeSelectOption>
              <NativeSelectOption value="required">{{ t('sharing.settings.encRequired') }}</NativeSelectOption>
            </NativeSelect>
          </label>
        </div>
        <label class="flex items-center gap-3 text-sm"><Switch v-model="form.autoBlock" />{{ t('sharing.settings.autoBlock') }}</label>
        <div v-if="form.autoBlock" class="grid grid-cols-3 gap-3">
          <label class="space-y-1"><span class="text-xs text-base-content/80">{{ t('sharing.settings.threshold') }}</span><Input v-model.number="form.blockThreshold" type="number" min="1" max="100" class="w-full" /></label>
          <label class="space-y-1"><span class="text-xs text-base-content/80">{{ t('sharing.settings.window') }}</span><Input v-model.number="form.blockWindowMin" type="number" min="1" max="1440" class="w-full" /></label>
          <label class="space-y-1"><span class="text-xs text-base-content/80">{{ t('sharing.settings.blockFor') }}</span><Input v-model.number="form.blockForMin" type="number" min="1" max="10080" class="w-full" /></label>
        </div>
      </Card>

      <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
      <div class="flex justify-end">
        <Button type="submit" size="sm" :disabled="!dirty || saving">{{ t('sharing.settings.save') }}</Button>
      </div>
    </form>

    <Card class="space-y-3 p-4">
      <h3 class="eyebrow">{{ t('sharing.settings.blocked') }}</h3>
      <p v-if="blocks.length === 0" class="text-sm text-base-content/70">{{ t('sharing.settings.noBlocked') }}</p>
      <ul v-else class="divide-y divide-base-300">
        <li v-for="b in blocks" :key="b.ip" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <code class="font-mono">{{ b.ip }}</code>
          <span class="text-xs text-base-content/70">{{ t('sharing.settings.until', { time: formatDateTime(b.until) }) }}</span>
          <span v-if="b.mine" class="text-xs font-medium text-warning">{{ t('sharing.settings.yours') }}</span>
          <Button variant="outline" size="xs" class="ml-auto" @click="unblock(b.ip)">{{ t('sharing.settings.unblock') }}</Button>
        </li>
      </ul>
    </Card>
  </div>
</template>
