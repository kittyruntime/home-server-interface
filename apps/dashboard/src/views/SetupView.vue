<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, computed, onMounted, watch } from 'vue'
import { TRPCClientError } from '@trpc/client'
import { useRoute, useRouter } from 'vue-router'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { applyPlanned } from '../lib/plan'
import { modeLabel, openAfterRestart, TRUST_STEPS } from '../lib/tls'
import { setupScreen, validHostname, type SetupStatus } from '../lib/setup'
import PlanDialog from '../components/ui/PlanDialog.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import LoadingState from '../components/ui/LoadingState.vue'
import RestoreForm from '../components/backup/RestoreForm.vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Label } from '@/components/ui/label'
import HsiMark from '../components/ui/HsiMark.vue'
import { ArchiveRestoreIcon, BellRingIcon, CheckIcon, ChevronRightIcon, FolderOpenIcon, HardDriveIcon, LockIcon, LockOpenIcon } from '@lucide/vue'

const { t } = useI18n()

/* First-run setup assistant (#12): the one-time link from the installer
   creates the administrator, then the server's identity, then next steps. */

const route = useRoute()
const router = useRouter()
const { isAuthenticated, setToken, logout } = useAuth()

const status = ref<SetupStatus | null>(null)
const loadError = ref('')
// The link carries the token in its fragment (#token=...): browsers never send
// it to the server, so it stays out of the server's request logs.
const SESSION_KEY = 'hsi-setup-session'
const setupSession = ref(sessionStorage.getItem(SESSION_KEY) ?? '')
watch(setupSession, v => { if (v) sessionStorage.setItem(SESSION_KEY, v); else sessionStorage.removeItem(SESSION_KEY) })
const tokenInput = ref(new URLSearchParams(route.hash.replace(/^#/, '')).get('token') ?? '')
// A new link pasted in the same tab only changes the fragment: check it too.
watch(() => route.hash, h => {
  const t = new URLSearchParams(h.replace(/^#/, '')).get('token')
  if (t && (screen.value === 'token' || screen.value === 'admin')) { tokenInput.value = t; void checkToken() }
})
const busy = ref(false)
const error = ref('')

const screen = computed(() => status.value ? setupScreen(status.value, isAuthenticated.value, !!setupSession.value) : null)
// Each step names what it uses on the machine (Product principle: show what
// will change). Commands and paths are identifiers, not translated.
const STEPS = [
  { id: 'admin', label: t('uis.views.SetupView.administrator'), uses: ['useradd', 'smbpasswd'] },
  { id: 'identity', label: t('uis.views.SetupView.server'), uses: ['hostnamectl', '/etc/hosts', 'timedatectl'] },
  { id: 'secure', label: t('uis.views.SetupView.secureAccess'), uses: ['/var/lib/hsi/tls'] },
  { id: 'next', label: t('uis.views.SetupView.nextSteps'), uses: [] as string[] },
]
const stepIndex = computed(() => {
  const s = screen.value
  return s === 'token' || s === 'admin' ? 0 : s === 'identity' || s === 'login' ? 1 : s === 'secure' ? 2 : 3
})

function message(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback
}

async function loadStatus() {
  try {
    status.value = await trpc.setup.status.query()
  } catch (e) {
    loadError.value = message(e, t('uis.views.SetupView.couldNotReachTheServer'))
  }
}

// ── Token ────────────────────────────────────────────────────────────────────
async function checkToken() {
  if (!tokenInput.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    setupSession.value = (await trpc.setup.verifyToken.mutate({ token: tokenInput.value.trim() })).setupToken
    // The token is single use: keep it out of the address bar and history.
    void router.replace({ path: '/setup', hash: '' })
  } catch (e) {
    error.value = message(e, t('uis.views.SetupView.thisSetupLinkIsNotValid'))
  } finally {
    busy.value = false
  }
}

// ── Administrator, or a configuration backup instead (#1) ────────────────────
const startMode = ref<'admin' | 'restore'>('admin')
function afterRestore() {
  // The restored accounts sign in: the setup session is over.
  setupSession.value = ''
  window.location.assign('/login')
}

// ── Administrator ────────────────────────────────────────────────────────────
const username = ref('')
const password = ref('')
const confirm = ref('')
const adminError = computed(() => {
  if (password.value && password.value.length < 6) return t('uis.views.SetupView.useAtLeast6Characters')
  if (confirm.value && confirm.value !== password.value) return t('uis.views.SetupView.thePasswordsDoNotMatch')
  return ''
})
async function createAdmin() {
  if (adminError.value || !username.value || !password.value || password.value !== confirm.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await trpc.setup.createAdmin.mutate({ setupToken: setupSession.value, username: username.value.trim(), password: password.value })
    setToken(res.token)
    localStorage.setItem('username', username.value.trim())
    setupSession.value = ''
    await loadStatus()
  } catch (e) {
    // An expired setup session: back to the token, for a new link.
    if (e instanceof TRPCClientError && e.data?.code === 'UNAUTHORIZED') setupSession.value = ''
    error.value = message(e, t('uis.views.SetupView.couldNotCreateTheAdministrator'))
  } finally {
    busy.value = false
  }
}

// ── Server identity ──────────────────────────────────────────────────────────
const hostname = ref('')
const timezone = ref('')
const timezones = ref<string[]>([])
const current = ref<{ hostname: string; timezone: string } | null>(null)
async function loadIdentity() {
  try {
    const id = await trpc.setup.identity.query()
    current.value = { hostname: id.hostname, timezone: id.timezone }
    hostname.value = id.hostname
    timezone.value = id.timezone
    timezones.value = id.timezones
  } catch (e) {
    // A session from another install or an expired one: sign in again.
    if (e instanceof TRPCClientError && e.data?.code === 'UNAUTHORIZED') { logout(); void router.replace('/login'); return }
    error.value = message(e, t('uis.views.SetupView.couldNotReadTheServerIdentity'))
  }
}
watch(screen, s => {
  if (s === 'identity' && !current.value) void loadIdentity()
  if (s === 'secure' && !tls.value) void loadTls()
  // A rejected session (another install's token) needs a new login first.
  if (s === 'login') void router.replace('/login')
}, { immediate: true })

const hostnameError = computed(() => hostname.value && !validHostname(hostname.value)
  ? t('uis.views.SetupView.hostnameRule') : '')
const identityChanged = computed(() => !!current.value && (hostname.value !== current.value.hostname || timezone.value !== current.value.timezone))

async function goTo(step: 'secure' | 'next' | 'done', skip?: 'identity' | 'secure') {
  await trpc.setup.progress.mutate({ step, ...(skip ? { skip } : {}) })
  if (step === 'done') { await router.replace('/'); return }
  await loadStatus()
}

async function applyIdentity() {
  if (hostnameError.value) return
  error.value = ''
  if (!identityChanged.value) { await goTo('secure'); return }
  try {
    await applyPlanned('system.identity', {
      ...(hostname.value !== current.value?.hostname ? { hostname: hostname.value } : {}),
      ...(timezone.value !== current.value?.timezone ? { timezone: timezone.value } : {}),
    }, { title: t('uis.views.SetupView.setTheServerIdentity'), actionLabel: t('uis.views.SetupView.apply') })
    await goTo('secure')
  } catch (e) {
    if (e instanceof Error && e.message) error.value = e.message
  }
}

onMounted(async () => {
  await loadStatus()
  if (screen.value === 'done') await router.replace(isAuthenticated.value ? '/' : '/login')
  else if (screen.value === 'login') await router.replace('/login')
  // A link carries its token: check it straight away.
  else if ((screen.value === 'token' || screen.value === 'admin') && tokenInput.value) await checkToken()
})

// ── Secure access ────────────────────────────────────────────────────────────
const tls = ref<Awaited<ReturnType<typeof trpc.tls.status.query>> | null>(null)
const tlsError = ref('')
const restarting = ref(false)
async function loadTls() {
  tlsError.value = ''
  try {
    tls.value = await trpc.tls.status.query()
  } catch (e) {
    if (e instanceof TRPCClientError && e.data?.code === 'UNAUTHORIZED') { logout(); void router.replace('/login'); return }
    tlsError.value = message(e, t('uis.views.SetupView.couldNotReadTheSecureAccess'))
  }
}
async function turnOnHttps() {
  if (!tls.value) return
  error.value = ''
  try {
    await applyPlanned('tls.enable', {}, { title: t('uis.views.SetupView.serveHsiOverHttps'), actionLabel: t('uis.views.SetupView.turnOn') })
    restarting.value = true
    await openAfterRestart(location, { from: tls.value.mode, https: true, port: tls.value.port, standardPorts: tls.value.standardPorts })
  } catch (e) {
    if (e instanceof Error && e.message) error.value = e.message
  } finally {
    restarting.value = false
  }
}

const NEXT = [
  { icon: HardDriveIcon, title: t('uis.views.SetupView.createOrImportAVolume'), text: t('uis.views.SetupView.turnFreeDisksIntoA'), href: '/?app=storage' },
  { icon: FolderOpenIcon, title: t('uis.views.SetupView.shareAFolder'), text: t('uis.views.SetupView.createAPlaceAndShare'), href: '/?app=sharing' },
  { icon: BellRingIcon, title: t('uis.views.SetupView.getAlerts'), text: t('uis.views.SetupView.sendDiskAndStorageAlerts'), href: '/?app=settings' },
  { icon: ArchiveRestoreIcon, title: t('uis.views.SetupView.restoreAConfigurationBackup'), text: t('uis.views.SetupView.alreadyHadHsiRestoreIts'), href: '/?app=settings' },
]

function openNext(href: string) {
  void trpc.setup.progress.mutate({ step: 'done' }).finally(() => router.replace(href))
}
</script>

<template>
  <div class="min-h-dvh bg-base-100 text-base-content lg:grid lg:grid-cols-[minmax(19rem,25rem)_minmax(0,1fr)]">
    <!-- Steps rail: where the setup stands, and what each step uses on the machine -->
    <aside class="hidden border-r border-base-300 bg-base-200 px-10 py-10 lg:flex lg:flex-col">
      <div class="flex items-center gap-3">
        <HsiMark class="size-8 shrink-0" />
        <span class="text-sm font-semibold">{{ $t('ui.views.SetupView.homeServerInterface') }}</span>
      </div>
      <h1 class="mt-14 text-2xl font-semibold tracking-tight text-balance">{{ $t('ui.views.SetupView.setUpYourServer') }}</h1>

      <ol class="mt-10" :aria-label="$t('ui.views.SetupView.setupSteps')">
        <li v-for="(s, i) in STEPS" :key="s.id" class="relative flex gap-4 pb-8 last:pb-0" :aria-current="i === stepIndex ? 'step' : undefined">
          <span v-if="i < STEPS.length - 1" aria-hidden="true"
            :class="['absolute top-8 bottom-1.5 left-3 w-px transition-colors duration-(--dur-slow)', i < stepIndex ? 'bg-primary/60' : 'bg-base-300']" />
          <span aria-hidden="true"
            :class="['relative grid size-6 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular-nums transition-colors duration-(--dur-slow)',
                     i < stepIndex ? 'bg-primary/15 text-primary' : i === stepIndex ? 'bg-primary text-primary-content ring-4 ring-primary/15' : 'border border-base-content/25 text-base-content/70']">
            <CheckIcon v-if="i < stepIndex" class="size-3.5" stroke-width="3" />
            <template v-else>{{ i + 1 }}</template>
          </span>
          <div class="min-w-0 pt-0.5">
            <p :class="['text-sm font-medium', i === stepIndex ? 'text-base-content' : 'text-base-content/75']">{{ s.label }}</p>
            <p v-if="s.uses.length" class="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 font-mono text-2xs text-base-content/70">
              <span class="sr-only">{{ $t('ui.views.SetupView.uses') }}</span>
              <span v-for="u in s.uses" :key="u">{{ u }}</span>
            </p>
          </div>
        </li>
      </ol>

      <p class="mt-auto max-w-[32ch] pt-10 text-xs text-base-content/70">{{ $t('ui.views.SetupView.railNote') }}</p>
    </aside>

    <!-- Phone and tablet: a compact progress bar instead of the rail -->
    <header class="sticky top-0 z-10 border-b border-base-300 bg-base-100/95 px-4 pt-3 pb-3 backdrop-blur lg:hidden">
      <div class="flex items-center gap-3">
        <HsiMark class="size-7 shrink-0" />
        <h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ $t('ui.views.SetupView.setUpYourServer') }}</h1>
        <span class="text-xs tabular-nums text-base-content/70">{{ $t('ui.views.SetupView.stepOf', { n: stepIndex + 1, total: STEPS.length }) }}</span>
      </div>
      <ol class="mt-3 grid grid-cols-4 gap-1.5" :aria-label="$t('ui.views.SetupView.setupSteps')">
        <li v-for="(s, i) in STEPS" :key="s.id" :aria-current="i === stepIndex ? 'step' : undefined">
          <span :class="['block h-1 rounded-full transition-colors duration-(--dur-slow)', i <= stepIndex ? 'bg-primary' : 'bg-base-300']" />
          <span :class="['mt-1.5 block truncate text-2xs', i === stepIndex ? 'font-medium text-base-content' : 'text-base-content/70']">{{ s.label }}</span>
        </li>
      </ol>
    </header>

    <main class="flex justify-center px-4 py-8 sm:px-8 lg:items-center lg:py-16">
      <div class="w-full max-w-lg">
        <LoadingState v-if="!status && !loadError" variant="compact" />
        <p v-else-if="loadError" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ loadError }}</p>

        <Transition v-else name="setup-step" mode="out-in">
          <!-- Token -->
          <form v-if="screen === 'token'" key="token" @submit.prevent="checkToken">
            <h2 class="text-xl font-semibold tracking-tight">{{ $t('ui.views.SetupView.openTheSetupLink') }}</h2>
            <p class="mt-2 text-sm text-base-content/80">
              {{ $t('ui.views.SetupView.theInstallerPrintedALink') }}
              <code class="rounded-selector bg-base-200 px-1.5 py-0.5 font-mono text-xs text-base-content">sudo hsi-worker setup-token</code>
              {{ $t('ui.views.SetupView.onTheServerForA') }}
              <code class="rounded-selector bg-base-200 px-1.5 py-0.5 font-mono text-xs text-base-content">sudo cat /etc/hsi/setup-token</code>.
            </p>
            <div class="mt-8 space-y-2">
              <Label for="setup-token">{{ $t('ui.views.SetupView.setupToken') }}</Label>
              <Input id="setup-token" v-model="tokenInput" class="font-mono" autocomplete="off" spellcheck="false" />
            </div>
            <p v-if="error" role="alert" class="status-text mt-4 text-error"><span class="status-tag">[ERR]</span> {{ error }}</p>
            <div class="mt-8 flex justify-end">
              <Button :disabled="busy || !tokenInput.trim()">{{ $t('ui.views.SetupView.continue') }}</Button>
            </div>
          </form>

          <!-- Start: a new server, or restore a configuration backup -->
          <div v-else-if="screen === 'admin'" key="admin">
            <Tabs v-model="startMode">
              <TabsList :aria-label="$t('ui.views.SetupView.howToStart')" class="w-full">
                <TabsTrigger value="admin">{{ $t('ui.views.SetupView.newServer') }}</TabsTrigger>
                <TabsTrigger value="restore">{{ $t('ui.views.SetupView.restoreABackup') }}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div v-if="startMode === 'restore'" class="mt-8 space-y-4">
              <h2 class="text-xl font-semibold tracking-tight">{{ $t('ui.views.SetupView.restoreABackup') }}</h2>
              <p class="text-sm text-base-content/80">{{ $t('ui.views.SetupView.rebuildAServerFromIts') }}</p>
              <RestoreForm :auth-token="setupSession" :after-restart="afterRestore" :show-follow-ups="false" />
            </div>
            <form v-else class="mt-8" @submit.prevent="createAdmin">
              <h2 class="text-xl font-semibold tracking-tight">{{ $t('ui.views.SetupView.createTheAdministrator') }}</h2>
              <p class="mt-2 text-sm text-base-content/80">{{ $t('ui.views.SetupView.thisAccountManagesTheServer') }}</p>
              <div class="mt-8 space-y-5">
                <div class="space-y-2">
                  <Label for="setup-username">{{ $t('ui.views.SetupView.username') }}</Label>
                  <Input id="setup-username" v-model="username" class="font-mono" autocomplete="username" :placeholder="$t('ui.views.SetupView.eGAlice')" spellcheck="false" autocapitalize="off" required />
                </div>
                <div class="grid gap-5 sm:grid-cols-2">
                  <div class="space-y-2">
                    <Label for="setup-password">{{ $t('ui.views.SetupView.password') }}</Label>
                    <Input id="setup-password" v-model="password" type="password" autocomplete="new-password" required />
                  </div>
                  <div class="space-y-2">
                    <Label for="setup-confirm">{{ $t('ui.views.SetupView.confirmThePassword') }}</Label>
                    <Input id="setup-confirm" v-model="confirm" type="password" autocomplete="new-password" required />
                  </div>
                </div>
              </div>
              <p v-if="adminError || error" role="alert" class="status-text mt-4 text-error"><span class="status-tag">[ERR]</span> {{ adminError || error }}</p>
              <div class="mt-8 flex justify-end">
                <Button :disabled="busy || !!adminError || !username || !password || password !== confirm">
                  {{ busy ? $t('ui.views.SetupView.creating') : $t('ui.views.SetupView.createTheAdministrator') }}
                </Button>
              </div>
            </form>
          </div>

          <!-- Server identity -->
          <form v-else-if="screen === 'identity'" key="identity" @submit.prevent="applyIdentity">
            <h2 class="text-xl font-semibold tracking-tight">{{ $t('ui.views.SetupView.nameTheServer') }}</h2>
            <p class="mt-2 text-sm text-base-content/80">{{ $t('ui.views.SetupView.theNameDevicesSeeOn') }}</p>
            <LoadingState v-if="!current && !error" variant="compact" class="mt-8" />
            <div v-else-if="current" class="mt-8 space-y-5">
              <div class="space-y-2">
                <Label for="setup-hostname">{{ $t('ui.views.SetupView.hostname') }}</Label>
                <Input id="setup-hostname" v-model="hostname" class="font-mono" spellcheck="false" autocapitalize="off" :aria-invalid="!!hostnameError || undefined" />
              </div>
              <div class="space-y-2">
                <Label for="setup-timezone">{{ $t('ui.views.SetupView.timeZone') }}</Label>
                <NativeSelect id="setup-timezone" v-model="timezone">
                  <NativeSelectOption v-for="z in timezones" :key="z" :value="z">{{ z }}</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
            <p v-if="hostnameError || error" role="alert" class="status-text mt-4 text-error"><span class="status-tag">[ERR]</span> {{ hostnameError || error }}</p>
            <div class="mt-8 flex items-center justify-between gap-3">
              <Button variant="ghost" type="button" @click="goTo('secure', 'identity')">{{ $t('ui.views.SetupView.skip') }}</Button>
              <Button :disabled="!current || !!hostnameError">{{ identityChanged ? $t('ui.views.SetupView.applyEllipsis') : $t('ui.views.SetupView.continue') }}</Button>
            </div>
          </form>

          <!-- Secure access -->
          <div v-else-if="screen === 'secure'" key="secure">
            <h2 class="text-xl font-semibold tracking-tight">{{ $t('ui.views.SetupView.secureAccess') }}</h2>
            <p class="mt-2 text-sm text-base-content/80">{{ $t('ui.views.SetupView.httpsEncryptsPasswordsAndFiles') }}</p>
            <p v-if="restarting" role="status" class="status-text mt-8 text-base-content/80">{{ $t('ui.views.SetupView.restartingHsi') }}</p>
            <LoadingState v-else-if="!tls && !tlsError" variant="compact" class="mt-8" />
            <div v-else-if="tls" class="mt-8 space-y-5">
              <div class="rounded-box border border-base-300 bg-base-200 px-4 py-3.5">
                <p class="flex items-center gap-2 text-sm font-medium">
                  <LockIcon v-if="tls.mode !== 'off'" class="size-4 text-success" aria-hidden="true" />
                  <LockOpenIcon v-else class="size-4 text-warning" aria-hidden="true" />
                  {{ modeLabel(tls.mode) }}
                </p>
                <template v-if="tls.mode === 'local' && tls.authorityFingerprint">
                  <p class="mt-3 text-xs text-base-content/70">{{ $t('ui.views.SetupView.authorityFingerprint') }}</p>
                  <p class="mt-1 break-all font-mono text-2xs text-base-content/85">{{ tls.authorityFingerprint }}</p>
                </template>
              </div>
              <template v-if="tls.mode === 'local'">
                <p class="text-sm text-base-content/80">{{ $t('ui.views.SetupView.installTheAuthorityCertificateOn') }}</p>
                <Button as="a" variant="outline" href="/ca.crt" download>{{ $t('ui.views.SetupView.downloadTheAuthorityCertificate') }}</Button>
                <details class="group text-sm text-base-content/80">
                  <summary class="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-base-content/80 hover:text-base-content [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon class="size-3.5 transition-transform duration-(--dur-fast) group-open:rotate-90" aria-hidden="true" />
                    {{ $t('ui.views.SetupView.howToTrustItOn') }}
                  </summary>
                  <dl class="mt-3 space-y-3 border-l border-base-300 pl-4">
                    <div v-for="step in TRUST_STEPS" :key="step.os">
                      <dt class="text-xs font-medium text-base-content">{{ step.os }}</dt>
                      <dd class="mt-0.5 text-xs">{{ step.steps }}</dd>
                    </div>
                  </dl>
                </details>
              </template>
              <div v-else-if="tls.mode === 'off'" class="space-y-3">
                <p class="text-sm text-base-content/80">{{ $t('ui.views.SetupView.hsiIsServedOverPlain') }}</p>
                <Button variant="outline" type="button" @click="turnOnHttps">{{ $t('ui.views.SetupView.turnHttpsOn') }}</Button>
              </div>
              <p class="text-xs text-base-content/70">{{ $t('ui.views.SetupView.importACertificateOrUse') }}</p>
            </div>
            <p v-if="tlsError || error" role="alert" class="status-text mt-4 text-error"><span class="status-tag">[ERR]</span> {{ tlsError || error }}</p>
            <div class="mt-8 flex items-center justify-between gap-3">
              <Button variant="ghost" type="button" :disabled="restarting" @click="goTo('next', 'secure')">{{ $t('ui.views.SetupView.skip') }}</Button>
              <Button type="button" :disabled="restarting" @click="goTo('next')">{{ $t('ui.views.SetupView.continue') }}</Button>
            </div>
          </div>

          <!-- Next steps -->
          <div v-else-if="screen === 'next'" key="next">
            <span class="grid size-10 place-items-center rounded-full bg-success/15 text-success" aria-hidden="true"><CheckIcon class="size-5" stroke-width="2.5" /></span>
            <h2 class="mt-5 text-2xl font-semibold tracking-tight">{{ $t('ui.views.SetupView.yourServerIsReady') }}</h2>
            <p class="mt-2 text-sm text-base-content/80">{{ $t('ui.views.SetupView.serverReadyLead') }}</p>
            <ul class="mt-8 divide-y divide-base-300 border-y border-base-300">
              <li v-for="n in NEXT" :key="n.title">
                <a :href="n.href" class="group -mx-2 flex items-center gap-4 rounded-field px-2 py-3.5 transition-colors duration-(--dur-fast) hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  @click.prevent="openNext(n.href)">
                  <span class="grid size-9 shrink-0 place-items-center rounded-field bg-primary/10 text-primary" aria-hidden="true"><component :is="n.icon" class="size-4.5" /></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium">{{ n.title }}</span>
                    <span class="mt-0.5 block text-xs text-base-content/70">{{ n.text }}</span>
                  </span>
                  <ChevronRightIcon class="size-4 shrink-0 text-base-content/50 transition-transform duration-(--dur-fast) group-hover:translate-x-0.5" aria-hidden="true" />
                </a>
              </li>
            </ul>
            <div class="mt-8 flex justify-end"><Button @click="goTo('done')">{{ $t('ui.views.SetupView.goToTheDashboard') }}</Button></div>
          </div>
        </Transition>
      </div>
    </main>
  </div>
  <PlanDialog />
  <ConfirmDialog />
</template>

<style scoped>
/* One authored moment: each step settles in from just below. */
.setup-step-enter-active,
.setup-step-leave-active {
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out);
}
.setup-step-leave-active {
  transition-duration: var(--dur-fast);
}
.setup-step-enter-from {
  opacity: 0;
  transform: translateY(0.5rem);
}
.setup-step-leave-to {
  opacity: 0;
}
</style>
