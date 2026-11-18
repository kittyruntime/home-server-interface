<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldBanIcon } from '@lucide/vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import BusyLabel from '../ui/BusyLabel.vue'
import LoadingState from '../ui/LoadingState.vue'
import SaveBar from './SaveBar.vue'
import { trpc } from '../../lib/trpc'
import { formatDateTime } from '../../lib/format-date'
import { useToast } from '../../lib/toast'
import { BLOCK_FIELDS, LIMITS, useSmbSettingsForm, type SmbBlock } from '../../lib/smb-settings-form'
import type { SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const toast = useToast()

const { form, dirty, invalid, hasInvalid, saving, error, reset, save } = useSmbSettingsForm(
  toRef(props, 'service'), BLOCK_FIELDS, { title: t('sharing.settings.savePlan'), action: t('sharing.settings.save'), failed: t('sharing.errors.action') })

async function submit() {
  if (await save()) {
    toast.success(t('sharing.settings.saved'))
    emit('changed')
  }
}

const numbers = computed(() => [
  { field: 'blockThreshold' as const, label: t('sharing.settings.threshold'), unit: '' },
  { field: 'blockWindowMin' as const, label: t('sharing.settings.window'), unit: t('sharing.settings.minutes') },
  { field: 'blockForMin' as const, label: t('sharing.settings.blockFor'), unit: t('sharing.settings.minutes') },
])

const blocks = ref<SmbBlock[]>([])
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
  <section class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.security.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.security.subtitle') }}</p>
    </div>

    <form v-if="form" novalidate class="space-y-4" @submit.prevent="submit">
      <Card class="gap-4 p-4 @2xl:p-5">
        <label class="flex cursor-pointer items-center justify-between gap-4">
          <span class="min-w-0">
            <span class="block text-sm font-semibold text-base-content">{{ t('sharing.settings.autoBlock') }}</span>
            <span class="block text-xs text-base-content/70">{{ t('sharing.settings.autoBlockHelp') }}</span>
          </span>
          <Switch v-model="form.autoBlock" class="shrink-0" />
        </label>
        <div v-if="form.autoBlock" class="grid max-w-xl gap-3 border-t border-base-300 pt-4 @md:grid-cols-3">
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
        <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
      </Card>
      <SaveBar v-if="dirty" :saving="saving" :invalid="hasInvalid" @reset="reset" />
    </form>

    <Card class="gap-0 overflow-hidden py-0">
      <div class="flex items-baseline justify-between gap-3 border-b border-base-300 px-4 py-3 @2xl:px-5">
        <h3 class="text-sm font-semibold text-base-content">{{ t('sharing.settings.blocked') }}</h3>
        <span v-if="blocks.length" class="text-xs text-base-content/70 tabular-nums">{{ blocks.length }}</span>
      </div>
      <LoadingState v-if="!blocksLoaded" variant="compact" />
      <p v-else-if="blocks.length === 0" class="px-4 py-6 text-sm text-base-content/70 @2xl:px-5">{{ t('sharing.settings.noBlocked') }}</p>
      <ul v-else class="divide-y divide-base-300/70">
        <li v-for="b in blocks" :key="b.ip" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 @2xl:px-5">
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
  </section>
</template>
