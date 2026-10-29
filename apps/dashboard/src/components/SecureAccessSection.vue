<script setup lang="ts">
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { applyPlanned } from '../lib/plan'
import { expiryState, modeLabel, openAfterRestart, TRUST_STEPS, type NextAddress } from '../lib/tls'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'


type Status = Awaited<ReturnType<typeof trpc.tls.status.query>>

const DOCS_URL = 'https://kittyruntime.github.io/home-server-interface/guide/secure-access/'

const status = ref<Status | null>(null)
const loading = ref(true)
const loadError = ref('')
const actionError = ref('')
const warnings = ref<string[]>([])
const restarting = ref(false)

const form = ref<'' | 'import' | 'proxy'>('')
const certFile = ref<File | null>(null)
const keyFile = ref<File | null>(null)
const proxies = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    status.value = await trpc.tls.status.query()
    proxies.value = status.value.trustedProxies.join('\n')
  } catch (e: any) {
    loadError.value = e?.message ?? 'Failed to load the secure access status'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const expiry = computed(() => status.value?.certificate ? expiryState(status.value.certificate.notAfter, new Date()) : null)
const isHttps = computed(() => status.value?.mode === 'local' || status.value?.mode === 'imported')

function ymd(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

async function afterPlan(next: Omit<NextAddress, 'from'>) {
  restarting.value = true
  try {
    await openAfterRestart(location, { ...next, from: status.value!.mode })
  } finally {
    restarting.value = false
  }
}

async function run(fn: () => Promise<void>) {
  actionError.value = ''
  warnings.value = []
  try {
    await fn()
  } catch (e: any) {
    if (e?.message) actionError.value = e.message
  }
}

function turnOn() {
  return run(async () => {
    await applyPlanned('tls.enable', {}, { title: 'Serve HSI over HTTPS', actionLabel: 'Turn on' })
    await afterPlan({ https: true, port: status.value!.port, standardPorts: status.value!.standardPorts })
  })
}

function useLocal() {
  return run(async () => {
    await applyPlanned('tls.useLocal', {}, { title: 'Use the local authority', actionLabel: 'Use the local authority' })
    await load()
  })
}

function onFile(which: 'cert' | 'key', e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  if (which === 'cert') certFile.value = f
  else keyFile.value = f
}

function submitImport() {
  return run(async () => {
    if (!certFile.value) { actionError.value = 'Choose a certificate file'; return }
    const cert = await certFile.value.text()
    const key = keyFile.value ? await keyFile.value.text() : ''
    const wasHttps = isHttps.value
    const reply = await applyPlanned('tls.import', { cert, key }, { title: 'Serve an imported certificate', actionLabel: 'Import' })
    warnings.value = reply.warnings
    form.value = ''
    certFile.value = null
    keyFile.value = null
    if (wasHttps) await load()
    else await afterPlan({ https: true, port: status.value!.port, standardPorts: status.value!.standardPorts })
  })
}

function submitProxy() {
  return run(async () => {
    const trustedProxies = proxies.value.split('\n').map(s => s.trim()).filter(Boolean)
    await applyPlanned('tls.proxy', { trustedProxies }, { title: 'Run behind a reverse proxy', actionLabel: 'Apply' })
    form.value = ''
    await afterPlan({ https: false, port: status.value!.port, standardPorts: false })
  })
}

function setStandardPorts(enabled: boolean) {
  return run(async () => {
    await applyPlanned('tls.standardPorts', { enabled }, {
      title: enabled ? 'Also serve on ports 443 and 80' : 'Stop serving on ports 443 and 80',
      actionLabel: enabled ? 'Turn on' : 'Turn off',
    })
    await afterPlan({ https: true, port: status.value!.port, standardPorts: enabled })
  })
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ $t('ui.settings.SecureAccessSection.secureAccess') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">{{ $t('ui.settings.SecureAccessSection.serveHsiOverHttpsSo') }}</p>

    <LoadingState v-if="loading" variant="compact" />
    <ErrorState v-else-if="loadError" :message="loadError" :retry-label="$t('ui.settings.SecureAccessSection.retry')" compact @retry="load" />
    <p v-else-if="restarting" role="status" class="status-text text-foreground/80">{{ $t('ui.settings.SecureAccessSection.restartingHsi') }}</p>

    <template v-else-if="status">
      <!-- Status -->
      <Card class="block gap-0 py-0 overflow-hidden p-5 mb-4">
        <div class="eyebrow mb-3">{{ $t('ui.settings.SecureAccessSection.status') }}</div>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between gap-4">
            <span class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.mode') }}</span>
            <span class="text-foreground">{{ modeLabel(status.mode) }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.port') }}</span>
            <span class="text-foreground tabular-nums">
              {{ status.port }}<template v-if="status.standardPorts">{{ $t('ui.settings.SecureAccessSection.also443With80Redirecting') }}</template>
            </span>
          </div>
          <template v-if="status.certificate">
            <div class="flex justify-between gap-4">
              <span class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.names') }}</span>
              <span class="text-foreground text-right break-all">{{ status.certificate.names.join(', ') }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.issuer') }}</span>
              <span class="text-foreground text-right break-all">{{ status.certificate.issuer }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.certificate') }}</span>
              <span class="text-foreground tabular-nums">expires {{ ymd(status.certificate.notAfter) }}</span>
            </div>
          </template>
          <div v-if="status.authorityFingerprint">
            <span class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.authorityFingerprint') }}</span>
            <p class="font-mono break-all text-xs text-foreground/80 mt-1">{{ status.authorityFingerprint }}</p>
          </div>
        </div>
        <p v-if="expiry?.level === 'soon'" class="mt-3 status-text text-warning"><span class="status-tag">[WARN]</span> The certificate expires in {{ expiry.days }} days.</p>
        <p v-else-if="expiry?.level === 'expired'" role="alert" class="mt-3 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ $t('ui.settings.SecureAccessSection.theCertificateHasExpired') }}</p>
        <p v-if="status.mode === 'proxy' && status.nginxSite" class="mt-3 text-xs text-muted-foreground">
          {{ $t('ui.settings.SecureAccessSection.thisServerStillHasThe') }}
        </p>
      </Card>

      <!-- Actions -->
      <Card class="block gap-0 py-0 overflow-hidden p-5 mb-4">
        <div class="eyebrow mb-3">{{ $t('ui.settings.SecureAccessSection.actions') }}</div>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" v-if="status.mode === 'off' || status.mode === 'proxy'" @click="turnOn">{{ $t('ui.settings.SecureAccessSection.turnHttpsOn') }}</Button>
          <Button variant="outline" size="sm" v-if="status.mode === 'imported'" @click="useLocal">{{ $t('ui.settings.SecureAccessSection.useTheLocalAuthority') }}</Button>
          <Button variant="outline" size="sm" @click="form = form === 'import' ? '' : 'import'">{{ $t('ui.settings.SecureAccessSection.importACertificate') }}</Button>
          <Button variant="outline" size="sm" @click="form = form === 'proxy' ? '' : 'proxy'">{{ $t('ui.settings.SecureAccessSection.behindAReverseProxy') }}</Button>
        </div>

        <form v-if="form === 'import'" class="mt-4 space-y-3" @submit.prevent="submitImport">
          <label class="block text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.certificateOrFullChain') }}
            <Input type="file" accept=".pem,.crt,.key" class="mt-1 text-sm" @change="onFile('cert', $event)" />
          </label>
          <label class="block text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.privateKeyOptionalWhenIt') }}
            <Input type="file" accept=".pem,.crt,.key" class="mt-1 text-sm" @change="onFile('key', $event)" />
          </label>
          <Button size="sm" type="submit">{{ $t('ui.settings.SecureAccessSection.reviewImport') }}</Button>
        </form>

        <form v-if="form === 'proxy'" class="mt-4 space-y-3" @submit.prevent="submitProxy">
          <label class="block text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.trustedProxiesOnePerLine') }}
            <Textarea v-model="proxies" rows="3" class="mt-1 w-full font-mono text-sm" />
          </label>
          <p class="text-xs text-muted-foreground">{{ $t('ui.settings.SecureAccessSection.leaveEmptyWhenTheProxy') }}</p>
          <Button size="sm" type="submit">{{ $t('ui.settings.SecureAccessSection.reviewChange') }}</Button>
        </form>

        <p v-for="w in warnings" :key="w" class="mt-3 status-text text-warning"><span class="status-tag">[WARN]</span> {{ w }}</p>
        <p v-if="actionError" role="alert" class="mt-3 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ actionError }}</p>

        <div v-if="isHttps" class="mt-4 flex items-center justify-between gap-4">
          <span class="text-sm text-foreground/80">{{ $t('ui.settings.SecureAccessSection.alsoServeOnPorts443') }}</span>
          <Switch :model-value="status.standardPorts" @update:model-value="setStandardPorts" />
        </div>
      </Card>

      <!-- Trust the authority -->
      <Card v-if="status.authorityFingerprint" class="block gap-0 py-0 overflow-hidden p-5">
        <div class="eyebrow mb-3">{{ $t('ui.settings.SecureAccessSection.trustTheAuthority') }}</div>
        <p class="text-xs text-muted-foreground mb-3">{{ $t('ui.settings.SecureAccessSection.installTheAuthorityCertificateOn') }}</p>
        <Button as="a" variant="outline" size="sm" href="/ca.crt" download>{{ $t('ui.settings.SecureAccessSection.downloadTheAuthorityCertificate') }}</Button>
        <details class="mt-3">
          <summary class="cursor-pointer text-sm text-foreground/80">{{ $t('ui.settings.SecureAccessSection.howToTrustItOn') }}</summary>
          <ul class="mt-2 space-y-2">
            <li v-for="t in TRUST_STEPS" :key="t.os" class="text-xs text-muted-foreground">
              <span class="font-semibold text-foreground">{{ t.os }}.</span> {{ t.steps }}
            </li>
          </ul>
        </details>
        <p class="mt-3 text-xs"><a :href="DOCS_URL" target="_blank" rel="noopener" class="text-primary hover:underline">{{ $t('ui.settings.SecureAccessSection.readTheFullGuide') }}</a></p>
      </Card>
    </template>
  </div>
</template>
