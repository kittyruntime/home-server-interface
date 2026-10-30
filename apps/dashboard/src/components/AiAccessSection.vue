<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { CheckIcon, CopyIcon, KeyRoundIcon } from '@lucide/vue'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'
import { formatDay } from '../lib/format-date'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import AssistantSettingsCard from './assistant/AssistantSettingsCard.vue'
import ClosedPlacesCard from './assistant/ClosedPlacesCard.vue'

// Access tokens for AI assistants (#138): an MCP client acts as this account
// with one, limited to the scopes picked here. The secret is shown once.

const { t } = useI18n()
const { isAdmin } = useAuth()
const toast = useToast()
const { confirm } = useConfirm()

type Token = Awaited<ReturnType<typeof trpc.apiToken.list.query>>[number]
type OtherToken = Awaited<ReturnType<typeof trpc.apiToken.listAll.query>>[number]

const DOMAINS = ['files', 'apps', 'storage', 'users', 'system'] as const
type Scope = `${typeof DOMAINS[number]}:${'read' | 'write'}`
const EXPIRIES = [7, 30, 90, 365, 0] as const

const loading = ref(true)
const error = ref('')
const tokens = ref<Token[]>([])
const others = ref<OtherToken[]>([])

const creating = ref(false)
const saving = ref(false)
const name = ref('')
const scopes = ref<Set<Scope>>(new Set(DOMAINS.map(d => `${d}:read` as Scope)))
const expiry = ref<number>(90)
const created = ref<{ name: string; secret: string } | null>(null)
const copied = ref(false)

const mcpUrl = computed(() => `${window.location.origin}/mcp`)
const claudeCommand = computed(() =>
  `claude mcp add --transport http hsi ${mcpUrl.value} --header "Authorization: Bearer ${created.value?.secret ?? '<token>'}"`)

async function load() {
  loading.value = true
  error.value = ''
  try {
    tokens.value = await trpc.apiToken.list.query()
    others.value = isAdmin.value ? (await trpc.apiToken.listAll.query()).filter(o => !tokens.value.some(t => t.id === o.id)) : []
  } catch (e: any) {
    error.value = e?.message ?? t('aiAccess.loadFailed')
  } finally {
    loading.value = false
  }
}

function toggle(scope: Scope, on: boolean) {
  const next = new Set(scopes.value)
  if (on) next.add(scope)
  else next.delete(scope)
  // Writing implies reading the same things.
  if (on && scope.endsWith(':write')) next.add(scope.replace(':write', ':read') as Scope)
  if (!on && scope.endsWith(':read')) next.delete(scope.replace(':read', ':write') as Scope)
  scopes.value = next
}

function startCreate() {
  name.value = ''
  scopes.value = new Set(DOMAINS.map(d => `${d}:read` as Scope))
  expiry.value = 90
  created.value = null
  creating.value = true
}

async function create() {
  saving.value = true
  try {
    const token = await trpc.apiToken.create.mutate({
      name: name.value.trim(),
      scopes: [...scopes.value],
      expiresInDays: (expiry.value || null) as 7 | 30 | 90 | 365 | null,
    })
    created.value = { name: token.name, secret: token.secret }
    creating.value = false
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? t('aiAccess.createFailed'))
  } finally {
    saving.value = false
  }
}

async function copy(text: string) {
  await navigator.clipboard?.writeText(text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

async function revoke(token: { id: string; name: string }) {
  if (!await confirm(t('aiAccess.revokeConfirm', { name: token.name }), { title: t('aiAccess.revokeTitle'), confirmLabel: t('aiAccess.revoke'), danger: true })) return
  try {
    await trpc.apiToken.revoke.mutate({ id: token.id })
    if (created.value?.name === token.name) created.value = null
    await load()
  } catch (e: any) {
    toast.error(e?.message ?? t('aiAccess.revokeFailed'))
  }
}

function state(token: Token): 'active' | 'revoked' | 'expired' {
  return token.revokedAt ? 'revoked' : token.active ? 'active' : 'expired'
}

onMounted(load)
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('aiAccess.title') }}</h2>
    <p class="text-sm text-muted-foreground mb-2 max-w-xl">{{ t('aiAccess.intro') }}</p>
    <p class="text-xs text-muted-foreground mb-6 max-w-xl">{{ t('aiAccess.privacy') }}</p>

    <!-- The built-in assistant (admins set it up) -->
    <div v-if="isAdmin" class="max-w-xl mb-8">
      <p class="eyebrow mb-2">{{ t('assistant.settings.section') }}</p>
      <AssistantSettingsCard />
    </div>

    <!-- What no assistant may open, built-in or over MCP (admins) -->
    <div v-if="isAdmin" class="max-w-xl mb-8">
      <p class="eyebrow mb-2">{{ t('assistant.closed.section') }}</p>
      <ClosedPlacesCard />
    </div>

    <p v-if="isAdmin" class="eyebrow mb-2">{{ t('aiAccess.mcpSection') }}</p>
    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" :retry-label="t('aiAccess.retry')" @retry="load" />

    <div v-else class="space-y-6 max-w-xl">
      <!-- The secret, once -->
      <Card v-if="created" class="gap-3 px-4 py-4 shadow-none border-primary/40">
        <p class="text-sm font-medium text-foreground">{{ t('aiAccess.createdTitle', { name: created.name }) }}</p>
        <p class="text-xs text-muted-foreground">{{ t('aiAccess.createdHint') }}</p>
        <div class="flex items-center gap-2">
          <code class="flex-1 min-w-0 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs select-all">{{ created.secret }}</code>
          <Button size="sm" variant="outline" :aria-label="t('aiAccess.copy')" @click="copy(created.secret)">
            <CheckIcon v-if="copied" class="size-4" aria-hidden="true" /><CopyIcon v-else class="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div>
          <p class="eyebrow mb-1">{{ t('aiAccess.connectClaudeCode') }}</p>
          <pre class="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-2xs text-foreground/80 select-all whitespace-pre-wrap break-all">{{ claudeCommand }}</pre>
        </div>
        <Button size="sm" variant="ghost" class="self-start" @click="created = null">{{ t('aiAccess.done') }}</Button>
      </Card>

      <!-- New token -->
      <div v-if="creating" class="bg-muted border border-input rounded-xl p-4 space-y-4">
        <div>
          <label for="ai-token-name" class="block text-xs text-muted-foreground mb-1">{{ t('aiAccess.name') }}</label>
          <Input id="ai-token-name" v-model="name" :placeholder="t('aiAccess.namePlaceholder')" maxlength="64" autofocus class="w-full px-3 py-1.5 text-sm" />
        </div>
        <div>
          <p class="block text-xs text-muted-foreground mb-2">{{ t('aiAccess.scopes') }}</p>
          <div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-2 text-sm">
            <span />
            <span class="text-xs text-muted-foreground">{{ t('aiAccess.read') }}</span>
            <span class="text-xs text-muted-foreground">{{ t('aiAccess.write') }}</span>
            <template v-for="domain in DOMAINS" :key="domain">
              <span class="text-foreground">{{ t(`aiAccess.domains.${domain}`) }}</span>
              <Checkbox :model-value="scopes.has(`${domain}:read`)" :aria-label="`${t(`aiAccess.domains.${domain}`)}: ${t('aiAccess.read')}`" @update:model-value="v => toggle(`${domain}:read`, v === true)" />
              <Checkbox :model-value="scopes.has(`${domain}:write`)" :aria-label="`${t(`aiAccess.domains.${domain}`)}: ${t('aiAccess.write')}`" @update:model-value="v => toggle(`${domain}:write`, v === true)" />
            </template>
          </div>
          <p class="text-xs text-muted-foreground mt-2">{{ t('aiAccess.scopesHint') }}</p>
        </div>
        <div>
          <label for="ai-token-expiry" class="block text-xs text-muted-foreground mb-1">{{ t('aiAccess.expires') }}</label>
          <NativeSelect id="ai-token-expiry" v-model="expiry" wrapper-class="w-48">
            <NativeSelectOption v-for="days in EXPIRIES" :key="days" :value="days">
              {{ days ? t('aiAccess.inDays', { days }) : t('aiAccess.never') }}
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div class="flex gap-2">
          <Button size="sm" :disabled="saving || !name.trim() || scopes.size === 0" @click="create">{{ t('aiAccess.create') }}</Button>
          <Button size="sm" variant="ghost" class="text-muted-foreground" @click="creating = false">{{ t('aiAccess.cancel') }}</Button>
        </div>
      </div>
      <Button v-else size="sm" @click="startCreate"><KeyRoundIcon class="size-4" aria-hidden="true" /> {{ t('aiAccess.newToken') }}</Button>

      <!-- Your tokens -->
      <div class="space-y-2">
        <p class="eyebrow">{{ t('aiAccess.yourTokens') }}</p>
        <p v-if="!tokens.length" class="text-sm text-muted-foreground">{{ t('aiAccess.none') }}</p>
        <Card v-for="token in tokens" :key="token.id" class="gap-2 px-4 py-3 shadow-none" :class="state(token) !== 'active' && 'opacity-60'">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm text-foreground truncate">{{ token.name }} <span class="font-mono text-xs text-muted-foreground">{{ token.prefix }}…</span></p>
              <p class="text-xs text-muted-foreground">
                {{ t('aiAccess.createdOn', { date: formatDay(token.createdAt) }) }}
                · {{ token.lastUsedAt ? t('aiAccess.lastUsed', { date: formatDay(token.lastUsedAt) }) : t('aiAccess.neverUsed') }}
                <template v-if="token.expiresAt && state(token) === 'active'"> · {{ t('aiAccess.expiresOn', { date: formatDay(token.expiresAt) }) }}</template>
              </p>
            </div>
            <Button v-if="state(token) === 'active'" size="sm" variant="outline" @click="revoke(token)">{{ t('aiAccess.revoke') }}</Button>
            <Badge v-else variant="secondary">{{ t(`aiAccess.state.${state(token)}`) }}</Badge>
          </div>
          <div class="flex flex-wrap gap-1">
            <Badge v-for="s in token.scopes" :key="s" variant="outline" class="font-mono text-2xs">{{ s }}</Badge>
          </div>
        </Card>
      </div>

      <!-- Everyone else's, for an admin -->
      <div v-if="isAdmin && others.length" class="space-y-2">
        <p class="eyebrow">{{ t('aiAccess.otherTokens') }}</p>
        <Card v-for="token in others" :key="token.id" class="flex flex-row items-center justify-between gap-3 px-4 py-3 shadow-none">
          <p class="text-sm text-foreground min-w-0 truncate">
            {{ token.user.username }} · {{ token.name }} <span class="font-mono text-xs text-muted-foreground">{{ token.prefix }}…</span>
          </p>
          <Button size="sm" variant="outline" @click="revoke(token)">{{ t('aiAccess.revoke') }}</Button>
        </Card>
      </div>
    </div>
  </div>
</template>
