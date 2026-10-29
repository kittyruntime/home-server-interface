<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { trpc } from '../lib/trpc'
import { applyPlanned } from '../lib/plan'
import { useToast } from '../lib/toast'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'

const { t } = useI18n()

type Status = Awaited<ReturnType<typeof trpc.network.status.query>>
type Iface = Status['interfaces'][number]

const toast = useToast()
const loading = ref(true)
const error = ref('')
const status = ref<Status | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    status.value = await trpc.network.status.query()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to read the network settings'
  } finally {
    loading.value = false
  }
}

// ── Editing one interface ────────────────────────────────────────────────────
const editing = ref<string | null>(null)
const form = ref({ method: 'auto' as 'auto' | 'manual', address: '', gateway: '', dns: '' })
const formError = ref('')

function edit(i: Iface) {
  editing.value = i.device
  formError.value = ''
  form.value = {
    method: i.method === 'manual' ? 'manual' : 'auto',
    address: i.configuredAddresses[0] ?? i.addresses[0] ?? '',
    gateway: i.configuredGateway ?? i.gateway ?? '',
    dns: (i.configuredDns.length ? i.configuredDns : []).join(', '),
  }
}

const dnsList = computed(() => form.value.dns.split(/[\s,]+/).filter(Boolean))

/** The page is served from this interface's current address. */
function servedFrom(i: Iface) {
  return i.addresses.some(a => a.split('/')[0] === location.hostname)
}

// The address the dashboard will be at after the change, when it moves.
function newAddress(i: Iface) {
  if (form.value.method !== 'manual' || !servedFrom(i)) return null
  const next = form.value.address.split('/')[0]
  return next && next !== location.hostname ? next : null
}

function newUrl(host: string) {
  return `${location.protocol}//${host}${location.port ? `:${location.port}` : ''}/?app=settings`
}

// ── After a change: keep it, or let NetworkManager put the old one back ─────
const pending = ref<{ checkpoint: string; expiresAt: number } | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
const secondsLeft = computed(() => pending.value ? Math.max(0, Math.round(pending.value.expiresAt - now.value / 1000)) : 0)

async function apply(i: Iface) {
  formError.value = ''
  const moving = newAddress(i)
  try {
    const reply = await applyPlanned('network.ipv4', {
      device: i.device,
      method: form.value.method,
      ...(form.value.method === 'manual' ? { address: form.value.address.trim(), ...(form.value.gateway.trim() ? { gateway: form.value.gateway.trim() } : {}) } : {}),
      dns: dnsList.value,
    }, {
      title: `Change the network of ${i.device}`,
      actionLabel: 'Apply',
      notice: moving
        ? `The dashboard moves to ${moving}. Open ${newUrl(moving)} and keep the change there within ${status.value?.confirmSeconds ?? 120} seconds, or the previous settings come back by themselves.`
        : `Keep the change within ${status.value?.confirmSeconds ?? 120} seconds once it is applied, or the previous settings come back by themselves.`,
    })
    editing.value = null
    if (typeof reply.checkpoint === 'string') {
      pending.value = { checkpoint: reply.checkpoint, expiresAt: Number(reply.expiresAt) || Date.now() / 1000 + 120 }
    }
    await load()
  } catch (e) {
    if (e instanceof Error && e.message) formError.value = e.message
  }
}

async function keep(checkpoint: string) {
  try {
    await trpc.network.confirm.mutate({ checkpoint })
    toast.success('Network settings kept')
  } catch (e: any) {
    toast.error(e?.message ?? 'The change could not be kept')
  }
  pending.value = null
  await load()
}

async function undo(checkpoint: string) {
  try {
    await trpc.network.rollback.mutate({ checkpoint })
    toast.success('Previous network settings restored')
  } catch (e: any) {
    toast.error(e?.message ?? 'The change could not be undone')
  }
  pending.value = null
  await load()
}

// A change made from another address, or before a reload, still waiting.
const waiting = computed(() => {
  const list = status.value?.pending ?? []
  return pending.value ? list.filter(c => c !== pending.value!.checkpoint) : list
})

onMounted(() => {
  void load()
  timer = setInterval(() => {
    now.value = Date.now()
    if (pending.value && secondsLeft.value === 0) { pending.value = null; void load() }
  }, 1000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.settings.NetworkSection.network') }}</h2>
    <p class="text-sm text-muted-foreground mb-6 max-w-xl">
      {{ t('ui.settings.NetworkSection.howThisServerGetsIts') }}
    </p>

    <LoadingState v-if="loading && !status" />
    <ErrorState v-else-if="error" :message="error" :retry-label="t('ui.settings.NetworkSection.retry')" @retry="load" />

    <div v-else-if="status" class="space-y-4 max-w-2xl">
      <Alert v-if="status.unavailable" variant="info" role="status">
        <AlertDescription class="text-foreground/80">{{ status.unavailable }}</AlertDescription>
      </Alert>

      <!-- The change just applied from this page -->
      <Alert v-if="pending" variant="warning" role="status" class="block space-y-2">
        <p class="font-medium">{{ t('ui.settings.NetworkSection.keepTheNewNetworkSettings') }}</p>
        <p class="text-foreground/80">{{ t('uip.settings.NetworkSection.ifYouCanReadThis', { p0: secondsLeft }) }}</p>
        <div class="flex gap-2">
          <Button size="sm" @click="keep(pending.checkpoint)">{{ t('ui.settings.NetworkSection.keep') }}</Button>
          <Button size="sm" variant="outline" @click="undo(pending.checkpoint)">{{ t('ui.settings.NetworkSection.undoNow') }}</Button>
        </div>
      </Alert>

      <!-- A change applied elsewhere (the old address), still waiting -->
      <Alert v-for="c in waiting" :key="c" variant="warning" role="status" class="block space-y-2">
        <p class="font-medium">{{ t('ui.settings.NetworkSection.aNetworkChangeIsWaiting') }}</p>
        <p class="text-foreground/80">{{ t('ui.settings.NetworkSection.itWasAppliedAMoment') }}</p>
        <div class="flex gap-2">
          <Button size="sm" @click="keep(c)">{{ t('ui.settings.NetworkSection.keep') }}</Button>
          <Button size="sm" variant="outline" @click="undo(c)">{{ t('ui.settings.NetworkSection.undoNow') }}</Button>
        </div>
      </Alert>

      <Card v-for="i in status.interfaces" :key="i.device" class="block gap-0 py-0 shadow-none p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-sm font-semibold text-foreground">{{ i.device }}</span>
              <Badge variant="secondary">{{ i.type }}</Badge>
              <Badge v-if="i.method" variant="outline">{{ i.method === 'manual' ? 'Manual' : 'DHCP' }}</Badge>
              <span class="text-xs text-muted-foreground">{{ i.state }}</span>
            </div>
            <p v-if="i.connection" class="text-xs text-muted-foreground mt-0.5">{{ i.connection }}</p>
          </div>
          <Button v-if="i.managed && editing !== i.device && !status.unavailable" variant="outline" size="sm" @click="edit(i)">{{ t('ui.settings.NetworkSection.change') }}</Button>
        </div>

        <dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <dt class="text-muted-foreground">{{ t('ui.settings.NetworkSection.address') }}</dt>
          <dd class="font-mono text-foreground/80">{{ i.addresses.join(', ') || 'none' }}</dd>
          <dt class="text-muted-foreground">{{ t('ui.settings.NetworkSection.gateway') }}</dt>
          <dd class="font-mono text-foreground/80">{{ i.gateway || 'none' }}</dd>
          <dt class="text-muted-foreground">DNS</dt>
          <dd class="font-mono text-foreground/80">{{ i.dns.join(', ') || 'none' }}</dd>
        </dl>
        <p v-if="!i.managed" class="mt-2 text-xs text-muted-foreground">{{ t('ui.settings.NetworkSection.networkmanagerDoesNotManageThis') }}</p>

        <form v-if="editing === i.device" class="mt-4 space-y-3 border-t pt-4" @submit.prevent="apply(i)">
          <ToggleGroup type="single" variant="outline" size="sm" :model-value="form.method" :aria-label="t('ui.settings.NetworkSection.addressing')"
            @update:model-value="v => { if (v === 'auto' || v === 'manual') form.method = v }">
            <ToggleGroupItem value="auto" class="px-3 text-xs">DHCP</ToggleGroupItem>
            <ToggleGroupItem value="manual" class="px-3 text-xs">{{ t('ui.settings.NetworkSection.manual') }}</ToggleGroupItem>
          </ToggleGroup>
          <div v-if="form.method === 'manual'" class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <Label :for="`addr-${i.device}`" class="text-xs">{{ t('ui.settings.NetworkSection.addressWithPrefix') }}</Label>
              <Input :id="`addr-${i.device}`" v-model="form.address" placeholder="192.168.1.20/24" class="font-mono" required />
            </div>
            <div class="space-y-1">
              <Label :for="`gw-${i.device}`" class="text-xs">{{ t('ui.settings.NetworkSection.gateway') }}</Label>
              <Input :id="`gw-${i.device}`" v-model="form.gateway" placeholder="192.168.1.1" class="font-mono" />
            </div>
          </div>
          <div class="space-y-1">
            <Label :for="`dns-${i.device}`" class="text-xs">{{ t('uip.settings.NetworkSection.dnsServers', { p0: form.method === 'auto' ? ' (empty: from DHCP)' : '' }) }}</Label>
            <Input :id="`dns-${i.device}`" v-model="form.dns" placeholder="1.1.1.1, 9.9.9.9" class="font-mono" />
          </div>
          <Alert v-if="newAddress(i)" variant="warning" role="note" class="block text-xs">
            {{ t('ui.settings.NetworkSection.theDashboardWillMoveTo') }} <span class="font-mono">{{ newAddress(i) }}</span>{{ t('ui.settings.NetworkSection.open') }}
            <span class="font-mono">{{ newUrl(newAddress(i)!) }}</span> {{ t('ui.settings.NetworkSection.andKeepTheChangeThere') }}
          </Alert>
          <p v-if="formError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ formError }}</p>
          <div class="flex gap-2">
            <Button type="submit" size="sm">{{ t('ui.settings.NetworkSection.review') }}</Button>
            <Button type="button" variant="ghost" size="sm" @click="editing = null">{{ t('ui.settings.NetworkSection.cancel') }}</Button>
          </div>
        </form>
      </Card>

      <p v-if="!status.unavailable && !status.interfaces.length" class="text-sm text-muted-foreground">{{ t('ui.settings.NetworkSection.noNetworkInterfaceFound') }}</p>
    </div>
  </div>
</template>
