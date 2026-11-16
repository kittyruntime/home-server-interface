<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import LoadingState from '../ui/LoadingState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import ShareActivity from './ShareActivity.vue'
import { trpc } from '../../lib/trpc'
import type { ShareEventRow, SharingService } from '../../lib/sharing-types'

const props = defineProps<{ service: SharingService | null; initialShare?: string }>()
const { t } = useI18n()

const PERIODS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const
type Period = keyof typeof PERIODS

const share = ref(props.initialShare ?? '')
const user = ref('')
const result = ref<'' | 'ok' | 'refused'>('')
const period = ref<Period>('week')
const shareNames = ref<string[]>([])

const events = ref<ShareEventRow[]>([])
const cursor = ref<string | null>(null)
const loading = ref(true)
// A filter change keeps the current lines on screen, dimmed, until the new ones arrive.
const reloading = ref(false)
const more = ref(false)
const error = ref('')

async function load(append = false, quiet = false) {
  if (append) more.value = true
  else if (!quiet) reloading.value = true
  try {
    const page = await trpc.sharing.events.query({
      share: share.value || undefined,
      user: user.value.trim() || undefined,
      result: result.value || undefined,
      sinceMs: Date.now() - PERIODS[period.value],
      cursor: append ? cursor.value ?? undefined : undefined,
      limit: 50,
    })
    events.value = append ? [...events.value, ...page.items] : page.items
    cursor.value = page.nextCursor
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message || t('sharing.errors.load')
  } finally {
    loading.value = false
    reloading.value = false
    more.value = false
  }
}

const filtered = computed(() => !!(share.value || user.value.trim() || result.value || period.value !== 'week'))
function clearFilters() {
  share.value = ''
  user.value = ''
  result.value = ''
  period.value = 'week'
}

// New connections show up on their own while the first page is on screen.
let timer: ReturnType<typeof setInterval> | null = null
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (typing) clearTimeout(typing)
})

let typing: ReturnType<typeof setTimeout> | null = null
watch([share, result, period], () => { void load() })
watch(user, () => {
  if (typing) clearTimeout(typing)
  typing = setTimeout(() => { void load() }, 300)
})
watch(() => props.initialShare, v => { if (v !== undefined) share.value = v })

onMounted(async () => {
  void load()
  timer = setInterval(() => {
    if (!document.hidden && !more.value && !reloading.value && events.value.length <= 50) void load(false, true)
  }, 15000)
  try {
    shareNames.value = (await trpc.sharing.list.query()).map(s => s.effectiveName)
  } catch { /* the filter keeps "all shares" */ }
})
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('sharing.journal.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('sharing.journal.subtitle') }}</p>
    </div>

    <Alert v-if="service?.state && service.state.installed && !service.state.audit" variant="info">
      <AlertDescription>{{ t('sharing.journal.unavailable') }}</AlertDescription>
    </Alert>

    <div class="grid grid-cols-1 gap-2 @md:grid-cols-2 @3xl:grid-cols-4">
      <NativeSelect v-model="share" wrapper-class="w-full" :aria-label="t('sharing.journal.shareFilter')">
        <NativeSelectOption value="">{{ t('sharing.journal.allShares') }}</NativeSelectOption>
        <NativeSelectOption v-for="n in shareNames" :key="n" :value="n">{{ n }}</NativeSelectOption>
      </NativeSelect>
      <Input v-model="user" type="search" autocomplete="off" spellcheck="false" :placeholder="t('sharing.journal.userPlaceholder')" :aria-label="t('sharing.journal.userFilter')" />
      <NativeSelect v-model="result" wrapper-class="w-full" :aria-label="t('sharing.journal.resultFilter')">
        <NativeSelectOption value="">{{ t('sharing.journal.allResults') }}</NativeSelectOption>
        <NativeSelectOption value="ok">{{ t('sharing.journal.ok') }}</NativeSelectOption>
        <NativeSelectOption value="refused">{{ t('sharing.journal.refused') }}</NativeSelectOption>
      </NativeSelect>
      <NativeSelect v-model="period" wrapper-class="w-full" :aria-label="t('sharing.journal.period')">
        <NativeSelectOption v-for="p in (Object.keys(PERIODS) as Period[])" :key="p" :value="p">{{ t(`sharing.journal.${p}`) }}</NativeSelectOption>
      </NativeSelect>
    </div>

    <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
    <LoadingState v-if="loading" variant="compact" />
    <Card v-else class="gap-0 px-4 py-3 transition-opacity duration-(--dur-base)" :class="reloading && 'opacity-60'" :aria-busy="reloading">
      <div v-if="events.length === 0" class="flex flex-wrap items-center justify-between gap-3 py-3">
        <p class="text-sm text-base-content/70">{{ t('sharing.journal.empty') }}</p>
        <Button v-if="filtered" variant="ghost" size="xs" @click="clearFilters">{{ t('sharing.journal.clearFilters') }}</Button>
      </div>
      <ShareActivity v-else :events="events" show-user hide-title by-day />
      <div v-if="cursor" class="flex justify-center pt-2 pb-1">
        <Button variant="outline" size="sm" :disabled="more" @click="load(true)">
          <BusyLabel :busy="more">{{ t('sharing.journal.loadMore') }}</BusyLabel>
        </Button>
      </div>
    </Card>
  </div>
</template>
