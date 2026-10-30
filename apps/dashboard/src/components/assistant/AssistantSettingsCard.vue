<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import BusyLabel from '../ui/BusyLabel.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { refreshAssistantStatus } from '../../lib/assistant'

// The built-in assistant's settings (administrators): the AI provider, its
// key and model, and who may chat. The key is sent once and never shown.

const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const toast = useToast()

type Settings = Awaited<ReturnType<typeof trpc.assistant.settings.query>>
type Provider = Settings['provider']

const PRESETS: Record<Provider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  custom: '',
}
const PROVIDERS = Object.keys(PRESETS) as Provider[]
const LOCAL: Provider[] = ['ollama', 'custom']

const loading = ref(true)
const error = ref('')
const saving = ref(false)
const testing = ref(false)
const stored = ref<Settings | null>(null)

const enabled = ref(false)
const provider = ref<Provider>('openrouter')
const baseUrl = ref(PRESETS.openrouter)
const apiKey = ref('')
const removeKey = ref(false)
const model = ref('')
const access = ref<'admins' | 'everyone'>('admins')
const readOnly = ref(false)
const dailyLimit = ref('')
const models = ref<string[]>([])
const testResult = ref<{ ok: boolean; text: string } | null>(null)

// The daily limit as typed: empty is no limit; below 1000 is refused.
const limitValue = computed(() => {
  const v = String(dailyLimit.value).trim()
  return v ? Number(v) : null
})
const limitValid = computed(() => limitValue.value === null || (Number.isInteger(limitValue.value) && limitValue.value >= 1000))

const needsKey = computed(() => !LOCAL.includes(provider.value))
const hasKey = computed(() => !!apiKey.value.trim() || (!!stored.value?.keySet && !removeKey.value))

function fill(s: Settings) {
  stored.value = s
  enabled.value = s.enabled
  provider.value = s.provider
  baseUrl.value = s.baseUrl
  model.value = s.model
  access.value = s.access
  readOnly.value = s.readOnly
  dailyLimit.value = s.dailyTokenLimit === null ? '' : String(s.dailyTokenLimit)
  apiKey.value = ''
  removeKey.value = false
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    fill(await trpc.assistant.settings.query())
  } catch (e: any) {
    error.value = e?.message ?? t('assistant.settings.loadFailed')
  } finally {
    loading.value = false
  }
}

function pickProvider(p: Provider) {
  if (PRESETS[provider.value] === baseUrl.value || !baseUrl.value) baseUrl.value = PRESETS[p]
  provider.value = p
  models.value = []
  testResult.value = null
}

async function test() {
  testing.value = true
  testResult.value = null
  try {
    const r = await trpc.assistant.testSettings.mutate({ baseUrl: baseUrl.value, ...(apiKey.value.trim() && { apiKey: apiKey.value.trim() }) })
    if (r.ok) {
      models.value = r.models
      testResult.value = { ok: true, text: t('assistant.settings.testOk', { n: r.models.length }) }
    } else {
      testResult.value = { ok: false, text: r.error }
    }
  } catch (e: any) {
    testResult.value = { ok: false, text: e?.message ?? t('assistant.settings.testFailed') }
  } finally {
    testing.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const key = apiKey.value.trim()
    fill(await trpc.assistant.saveSettings.mutate({
      enabled: enabled.value, provider: provider.value, baseUrl: baseUrl.value, model: model.value.trim(), access: access.value,
      readOnly: readOnly.value, dailyTokenLimit: limitValue.value,
      ...(key ? { apiKey: key } : removeKey.value ? { apiKey: null } : {}),
    }))
    toast.success(t('assistant.settings.saved'))
    await refreshAssistantStatus()
    emit('saved')
  } catch (e: any) {
    toast.error(e?.message ?? t('assistant.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <LoadingState v-if="loading" />
  <ErrorState v-else-if="error" :message="error" :retry-label="t('common.retry')" @retry="load" />
  <Card v-else class="gap-4 px-4 py-4 shadow-none">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-sm font-medium text-foreground">{{ t('assistant.settings.title') }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('assistant.settings.intro') }}</p>
      </div>
      <Switch v-model="enabled" :aria-label="t('assistant.settings.enabled')" />
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label for="assistant-provider" class="block text-xs text-muted-foreground mb-1">{{ t('assistant.settings.provider') }}</label>
        <NativeSelect id="assistant-provider" :model-value="provider" class="w-full" @update:model-value="v => pickProvider(v as Provider)">
          <NativeSelectOption v-for="p in PROVIDERS" :key="p" :value="p">{{ t(`assistant.settings.providers.${p}`) }}</NativeSelectOption>
        </NativeSelect>
      </div>
      <div>
        <label for="assistant-url" class="block text-xs text-muted-foreground mb-1">{{ t('assistant.settings.baseUrl') }}</label>
        <Input id="assistant-url" v-model="baseUrl" placeholder="https://…/v1" class="w-full px-3 py-1.5 text-sm font-mono" />
      </div>
    </div>

    <div>
      <label for="assistant-key" class="block text-xs text-muted-foreground mb-1">
        {{ t('assistant.settings.apiKey') }}<template v-if="!needsKey"> ({{ t('assistant.settings.optional') }})</template>
      </label>
      <div class="flex items-center gap-2">
        <Input
          id="assistant-key" v-model="apiKey" type="password" autocomplete="off"
          :placeholder="stored?.keySet && !removeKey ? t('assistant.settings.keyKept') : t('assistant.settings.keyPlaceholder')"
          class="flex-1 px-3 py-1.5 text-sm"
        />
        <Button v-if="stored?.keySet && !removeKey && !apiKey" size="sm" variant="ghost" @click="removeKey = true">{{ t('assistant.settings.removeKey') }}</Button>
      </div>
      <p v-if="stored?.keyUnreadable" class="mt-1 text-xs text-destructive">{{ t('assistant.settings.keyUnreadable') }}</p>
      <p v-else-if="removeKey" class="mt-1 text-xs text-muted-foreground">{{ t('assistant.settings.keyRemoved') }}</p>
    </div>

    <div>
      <div class="flex items-end gap-2">
        <div class="min-w-0 flex-1">
          <label for="assistant-model" class="block text-xs text-muted-foreground mb-1">{{ t('assistant.settings.model') }}</label>
          <Input id="assistant-model" v-model="model" list="assistant-models" :placeholder="t('assistant.settings.modelPlaceholder')" class="w-full px-3 py-1.5 text-sm font-mono" />
          <datalist id="assistant-models">
            <option v-for="m in models" :key="m" :value="m" />
          </datalist>
        </div>
        <Button size="sm" variant="outline" :disabled="testing || !baseUrl || (needsKey && !hasKey)" @click="test">
          <BusyLabel :busy="testing" :busy-label="t('assistant.settings.testing')">{{ t('assistant.settings.test') }}</BusyLabel>
        </Button>
      </div>
      <p v-if="testResult" class="mt-1 text-xs break-words" :class="testResult.ok ? 'text-success' : 'text-destructive'">{{ testResult.text }}</p>
      <p v-else class="mt-1 text-xs text-muted-foreground">{{ t('assistant.settings.modelHint') }}</p>
    </div>

    <div>
      <label for="assistant-access" class="block text-xs text-muted-foreground mb-1">{{ t('assistant.settings.access') }}</label>
      <NativeSelect id="assistant-access" v-model="access" class="w-full">
        <NativeSelectOption value="admins">{{ t('assistant.settings.accessAdmins') }}</NativeSelectOption>
        <NativeSelectOption value="everyone">{{ t('assistant.settings.accessEveryone') }}</NativeSelectOption>
      </NativeSelect>
    </div>

    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-sm text-foreground">{{ t('assistant.settings.readOnly') }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('assistant.settings.readOnlyHint') }}</p>
      </div>
      <Switch v-model="readOnly" :aria-label="t('assistant.settings.readOnly')" />
    </div>

    <div>
      <label for="assistant-limit" class="block text-xs text-muted-foreground mb-1">{{ t('assistant.settings.dailyLimit') }}</label>
      <Input id="assistant-limit" v-model="dailyLimit" type="number" min="1000" step="1000" inputmode="numeric" placeholder="200000"
        :aria-invalid="!limitValid || undefined" class="w-full sm:w-48 px-3 py-1.5 text-sm" />
      <p class="mt-1 text-xs text-muted-foreground">{{ t('assistant.settings.dailyLimitHint') }}</p>
    </div>

    <p class="text-xs text-muted-foreground">{{ t('assistant.settings.privacy') }}</p>

    <div class="flex justify-end">
      <Button size="sm" :disabled="saving || !limitValid || (enabled && (!model.trim() || (needsKey && !hasKey)))" @click="save">
        <BusyLabel :busy="saving" :busy-label="t('assistant.settings.saving')">{{ t('common.save') }}</BusyLabel>
      </Button>
    </div>
  </Card>
</template>
