<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import BusyLabel from '../ui/BusyLabel.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import PlaceIcon from '../PlaceIcon.vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'

// Places no AI assistant may open, built-in or over MCP (administrators):
// their files are never read, listed or changed by one, so they never reach
// an AI provider.

const { t } = useI18n()
const toast = useToast()

type Place = Awaited<ReturnType<typeof trpc.place.list.query>>[number]

const loading = ref(true)
const error = ref('')
const saving = ref(false)
const places = ref<Place[]>([])
const saved = ref<string[]>([])
const closed = ref<Set<string>>(new Set())

const changed = computed(() => saved.value.length !== closed.value.size || saved.value.some(id => !closed.value.has(id)))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [list, ex] = await Promise.all([trpc.place.list.query(), trpc.assistant.excludedPlaces.query()])
    places.value = list
    saved.value = ex.placeIds
    closed.value = new Set(ex.placeIds)
  } catch (e: any) {
    error.value = e?.message ?? t('assistant.closed.loadFailed')
  } finally {
    loading.value = false
  }
}

function toggle(id: string, on: boolean) {
  const next = new Set(closed.value)
  if (on) next.add(id)
  else next.delete(id)
  closed.value = next
}

async function save() {
  saving.value = true
  try {
    saved.value = (await trpc.assistant.setExcludedPlaces.mutate({ placeIds: [...closed.value] })).placeIds
    closed.value = new Set(saved.value)
    toast.success(t('assistant.closed.saved'))
  } catch (e: any) {
    toast.error(e?.message ?? t('assistant.closed.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <LoadingState v-if="loading" />
  <ErrorState v-else-if="error" :message="error" :retry-label="t('common.retry')" @retry="load" />
  <Card v-else class="gap-3 px-4 py-4 shadow-none">
    <div>
      <p class="text-sm font-medium text-foreground">{{ t('assistant.closed.title') }}</p>
      <p class="mt-0.5 text-xs text-muted-foreground">{{ t('assistant.closed.intro') }}</p>
    </div>
    <p v-if="!places.length" class="text-xs text-muted-foreground">{{ t('assistant.closed.none') }}</p>
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li v-for="p in places" :key="p.id">
        <label class="flex cursor-pointer items-center gap-3 px-3 py-2">
          <Checkbox :model-value="closed.has(p.id)" @update:model-value="v => toggle(p.id, v === true)" />
          <PlaceIcon :icon="p.icon" class="size-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-foreground">{{ p.name }}</span>
            <span class="block truncate font-mono text-2xs text-muted-foreground">{{ p.path }}</span>
          </span>
          <span v-if="closed.has(p.id)" class="shrink-0 text-xs text-muted-foreground">{{ t('assistant.closed.closedLabel') }}</span>
        </label>
      </li>
    </ul>
    <div v-if="places.length" class="flex justify-end">
      <Button size="sm" :disabled="saving || !changed" @click="save">
        <BusyLabel :busy="saving" :busy-label="t('assistant.settings.saving')">{{ t('common.save') }}</BusyLabel>
      </Button>
    </div>
  </Card>
</template>
