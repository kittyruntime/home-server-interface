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
    <h2 class="text-lg font-semibold text-foreground mb-1">Secure access</h2>
    <p class="text-sm text-muted-foreground mb-6">Serve HSI over HTTPS so passwords and files are encrypted on your network.</p>

    <LoadingState v-if="loading" variant="compact" />
    <ErrorState v-else-if="loadError" :message="loadError" retry-label="Retry" compact @retry="load" />
    <p v-else-if="restarting" role="status" class="status-text text-foreground/80">Restarting HSI…</p>

    <template v-else-if="status">
      <!-- Status -->
      <Card class="block gap-0 py-0 overflow-hidden p-5 mb-4">
        <div class="eyebrow mb-3">Status</div>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between gap-4">
            <span class="text-xs text-muted-foreground">Mode</span>
            <span class="text-foreground">{{ modeLabel(status.mode) }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-xs text-muted-foreground">Port</span>
            <span class="text-foreground tabular-nums">
              {{ status.port }}<template v-if="status.standardPorts">, also 443, with 80 redirecting</template>
            </span>
          </div>
          <template v-if="status.certificate">
            <div class="flex justify-between gap-4">
              <span class="text-xs text-muted-foreground">Names</span>
              <span class="text-foreground text-right break-all">{{ status.certificate.names.join(', ') }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-xs text-muted-foreground">Issuer</span>
              <span class="text-foreground text-right break-all">{{ status.certificate.issuer }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-xs text-muted-foreground">Certificate</span>
              <span class="text-foreground tabular-nums">expires {{ ymd(status.certificate.notAfter) }}</span>
            </div>
          </template>
          <div v-if="status.authorityFingerprint">
            <span class="text-xs text-muted-foreground">Authority fingerprint</span>
            <p class="font-mono break-all text-xs text-foreground/80 mt-1">{{ status.authorityFingerprint }}</p>
          </div>
        </div>
        <p v-if="expiry?.level === 'soon'" class="mt-3 status-text text-warning"><span class="status-tag">[WARN]</span> The certificate expires in {{ expiry.days }} days.</p>
        <p v-else-if="expiry?.level === 'expired'" role="alert" class="mt-3 status-text text-destructive"><span class="status-tag">[ERR]</span> The certificate has expired.</p>
        <p v-if="status.mode === 'proxy' && status.nginxSite" class="mt-3 text-xs text-muted-foreground">
          This server still has the nginx site created by older versions. To let HSI serve HTTPS itself, turn HTTPS on here, then remove both /etc/nginx/sites-enabled/hsi and /etc/nginx/sites-available/hsi and reload nginx.
        </p>
      </Card>

      <!-- Actions -->
      <Card class="block gap-0 py-0 overflow-hidden p-5 mb-4">
        <div class="eyebrow mb-3">Actions</div>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" v-if="status.mode === 'off' || status.mode === 'proxy'" @click="turnOn">Turn HTTPS on…</Button>
          <Button variant="outline" size="sm" v-if="status.mode === 'imported'" @click="useLocal">Use the local authority…</Button>
          <Button variant="outline" size="sm" @click="form = form === 'import' ? '' : 'import'">Import a certificate…</Button>
          <Button variant="outline" size="sm" @click="form = form === 'proxy' ? '' : 'proxy'">Behind a reverse proxy…</Button>
        </div>

        <form v-if="form === 'import'" class="mt-4 space-y-3" @submit.prevent="submitImport">
          <label class="block text-xs text-muted-foreground">Certificate or full chain
            <Input type="file" accept=".pem,.crt,.key" class="mt-1 text-sm" @change="onFile('cert', $event)" />
          </label>
          <label class="block text-xs text-muted-foreground">Private key (optional when it is in the same file)
            <Input type="file" accept=".pem,.crt,.key" class="mt-1 text-sm" @change="onFile('key', $event)" />
          </label>
          <Button size="sm" type="submit">Review import</Button>
        </form>

        <form v-if="form === 'proxy'" class="mt-4 space-y-3" @submit.prevent="submitProxy">
          <label class="block text-xs text-muted-foreground">Trusted proxies, one per line
            <Textarea v-model="proxies" rows="3" class="mt-1 w-full font-mono text-sm" />
          </label>
          <p class="text-xs text-muted-foreground">Leave empty when the proxy runs on this server</p>
          <Button size="sm" type="submit">Review change</Button>
        </form>

        <p v-for="w in warnings" :key="w" class="mt-3 status-text text-warning"><span class="status-tag">[WARN]</span> {{ w }}</p>
        <p v-if="actionError" role="alert" class="mt-3 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ actionError }}</p>

        <div v-if="isHttps" class="mt-4 flex items-center justify-between gap-4">
          <span class="text-sm text-foreground/80">Also serve on ports 443 and 80</span>
          <Switch :model-value="status.standardPorts" @update:model-value="setStandardPorts" />
        </div>
      </Card>

      <!-- Trust the authority -->
      <Card v-if="status.authorityFingerprint" class="block gap-0 py-0 overflow-hidden p-5">
        <div class="eyebrow mb-3">Trust the authority</div>
        <p class="text-xs text-muted-foreground mb-3">Install the authority certificate on each device so browsers stop showing a warning.</p>
        <Button as="a" variant="outline" size="sm" href="/ca.crt" download>Download the authority certificate</Button>
        <details class="mt-3">
          <summary class="cursor-pointer text-sm text-foreground/80">How to trust it on your device</summary>
          <ul class="mt-2 space-y-2">
            <li v-for="t in TRUST_STEPS" :key="t.os" class="text-xs text-muted-foreground">
              <span class="font-semibold text-foreground">{{ t.os }}.</span> {{ t.steps }}
            </li>
          </ul>
        </details>
        <p class="mt-3 text-xs"><a :href="DOCS_URL" target="_blank" rel="noopener" class="text-primary hover:underline">Read the full guide</a></p>
      </Card>
    </template>
  </div>
</template>
