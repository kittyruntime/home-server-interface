<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { TRPCClientError } from '@trpc/client'
import { useRoute, useRouter } from 'vue-router'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { applyPlanned } from '../lib/plan'
import { setupScreen, validHostname, type SetupStatus } from '../lib/setup'
import PlanDialog from '../components/ui/PlanDialog.vue'
import LoadingState from '../components/ui/LoadingState.vue'

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
const STEPS = [
  { id: 'admin', label: 'Administrator' },
  { id: 'identity', label: 'Server' },
  { id: 'next', label: 'Next steps' },
]
const stepIndex = computed(() => {
  const s = screen.value
  return s === 'token' || s === 'admin' ? 0 : s === 'identity' || s === 'login' ? 1 : 2
})

function message(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback
}

async function loadStatus() {
  try {
    status.value = await trpc.setup.status.query()
  } catch (e) {
    loadError.value = message(e, 'Could not reach the server')
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
    error.value = message(e, 'This setup link is not valid')
  } finally {
    busy.value = false
  }
}

// ── Administrator ────────────────────────────────────────────────────────────
const username = ref('')
const password = ref('')
const confirm = ref('')
const adminError = computed(() => {
  if (password.value && password.value.length < 6) return 'Use at least 6 characters'
  if (confirm.value && confirm.value !== password.value) return 'The passwords do not match'
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
    error.value = message(e, 'Could not create the administrator')
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
    error.value = message(e, 'Could not read the server identity')
  }
}
watch(screen, s => {
  if (s === 'identity' && !current.value) void loadIdentity()
  // A rejected session (another install's token) needs a new login first.
  if (s === 'login') void router.replace('/login')
}, { immediate: true })

const hostnameError = computed(() => hostname.value && !validHostname(hostname.value)
  ? 'Use letters, digits and hyphens (up to 63), not starting or ending with a hyphen' : '')
const identityChanged = computed(() => !!current.value && (hostname.value !== current.value.hostname || timezone.value !== current.value.timezone))

async function goTo(step: 'next' | 'done', skip?: 'identity') {
  await trpc.setup.progress.mutate({ step, ...(skip ? { skip } : {}) })
  if (step === 'done') { await router.replace('/'); return }
  await loadStatus()
}

async function applyIdentity() {
  if (hostnameError.value) return
  error.value = ''
  if (!identityChanged.value) { await goTo('next'); return }
  try {
    await applyPlanned('system.identity', {
      ...(hostname.value !== current.value?.hostname ? { hostname: hostname.value } : {}),
      ...(timezone.value !== current.value?.timezone ? { timezone: timezone.value } : {}),
    }, { title: 'Set the server identity', actionLabel: 'Apply' })
    await goTo('next')
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

const NEXT = [
  { title: 'Create or import a volume', text: 'Turn free disks into a volume, or bring back the arrays already on them.', href: '/?app=storage' },
  { title: 'Share a folder', text: 'Create a Place and share it over SMB with your devices.', href: '/?app=sharing' },
  { title: 'Get alerts', text: 'Send disk and storage alerts to email, Discord, ntfy or a webhook.', href: '/?app=settings' },
  { title: 'Restore a configuration backup', text: 'Already had HSI? Restore its encrypted configuration backup.', href: '/?app=settings' },
]
</script>

<template>
  <div class="min-h-screen bg-[var(--c-bg)] px-4 py-10 flex justify-center">
    <div class="w-full max-w-xl">
      <div class="mb-8 text-center">
        <div class="eyebrow mb-1">Home Server Interface</div>
        <h1 class="text-2xl font-semibold text-[var(--c-text-1)]">Set up your server</h1>
      </div>

      <ol class="mb-6 flex items-center justify-center gap-2 text-xs" aria-label="Setup steps">
        <li v-for="(s, i) in STEPS" :key="s.id" class="flex items-center gap-2">
          <span :class="['grid h-6 w-6 place-items-center rounded-full border text-2xs font-semibold',
            i < stepIndex ? 'border-success bg-success/10 text-success' : i === stepIndex ? 'border-[var(--c-accent)] text-[var(--c-accent)]' : 'border-[var(--c-border-strong)] text-[var(--c-text-3)]']"
            :aria-current="i === stepIndex ? 'step' : undefined">{{ i + 1 }}</span>
          <span :class="i === stepIndex ? 'text-[var(--c-text-1)]' : 'text-[var(--c-text-3)]'">{{ s.label }}</span>
          <span v-if="i < STEPS.length - 1" aria-hidden="true" class="mx-1 h-px w-6 bg-[var(--c-border-strong)]" />
        </li>
      </ol>

      <div class="rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-surface)] p-6 space-y-4">
        <LoadingState v-if="!status && !loadError" variant="compact" />
        <p v-else-if="loadError" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ loadError }}</p>

        <!-- Token -->
        <form v-else-if="screen === 'token'" class="space-y-4" @submit.prevent="checkToken">
          <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Open the setup link</h2>
          <p class="text-sm text-[var(--c-text-2)]">
            The installer printed a link to finish the setup. If you no longer have it, run
            <code class="font-mono text-xs">sudo hsi-worker setup-token</code> on the server for a new one, or read the token with
            <code class="font-mono text-xs">sudo cat /etc/hsi/setup-token</code>.
          </p>
          <label class="block text-xs text-[var(--c-text-2)]">Setup token
            <input v-model="tokenInput" class="ui-input mt-1 font-mono" autocomplete="off" spellcheck="false" />
          </label>
          <p v-if="error" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>
          <div class="flex justify-end"><button class="btn btn-primary btn-sm" :disabled="busy || !tokenInput.trim()">Continue</button></div>
        </form>

        <!-- Administrator -->
        <form v-else-if="screen === 'admin'" class="space-y-4" @submit.prevent="createAdmin">
          <div>
            <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Create the administrator</h2>
            <p class="mt-1 text-sm text-[var(--c-text-2)]">This account manages the server. It is also a Linux and SMB account, so it can open the shares.</p>
          </div>
          <label class="block text-xs text-[var(--c-text-2)]">Username
            <input v-model="username" class="ui-input mt-1" autocomplete="username" placeholder="e.g. alice" spellcheck="false" required />
          </label>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block text-xs text-[var(--c-text-2)]">Password
              <input v-model="password" type="password" class="ui-input mt-1" autocomplete="new-password" required />
            </label>
            <label class="block text-xs text-[var(--c-text-2)]">Confirm the password
              <input v-model="confirm" type="password" class="ui-input mt-1" autocomplete="new-password" required />
            </label>
          </div>
          <p v-if="adminError || error" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ adminError || error }}</p>
          <div class="flex justify-end">
            <button class="btn btn-primary btn-sm" :disabled="busy || !!adminError || !username || !password || password !== confirm">
              {{ busy ? 'Creating…' : 'Create the administrator' }}
            </button>
          </div>
        </form>

        <!-- Server identity -->
        <form v-else-if="screen === 'identity'" class="space-y-4" @submit.prevent="applyIdentity">
          <div>
            <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Name the server</h2>
            <p class="mt-1 text-sm text-[var(--c-text-2)]">The name devices see on the network, and the time zone used for schedules and logs.</p>
          </div>
          <LoadingState v-if="!current && !error" variant="compact" />
          <template v-else-if="current">
            <label class="block text-xs text-[var(--c-text-2)]">Hostname
              <input v-model="hostname" class="ui-input mt-1 font-mono" spellcheck="false" />
            </label>
            <label class="block text-xs text-[var(--c-text-2)]">Time zone
              <select v-model="timezone" class="ui-input mt-1">
                <option v-for="z in timezones" :key="z" :value="z">{{ z }}</option>
              </select>
            </label>
          </template>
          <p v-if="hostnameError || error" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ hostnameError || error }}</p>
          <div class="flex justify-between">
            <button type="button" class="btn btn-ghost btn-sm" @click="goTo('next', 'identity')">Skip</button>
            <button class="btn btn-primary btn-sm" :disabled="!current || !!hostnameError">{{ identityChanged ? 'Apply…' : 'Continue' }}</button>
          </div>
        </form>

        <!-- Next steps -->
        <div v-else-if="screen === 'next'" class="space-y-4">
          <div>
            <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Your server is ready</h2>
            <p class="mt-1 text-sm text-[var(--c-text-2)]">A few things worth doing next. Everything stays available later from the dashboard.</p>
          </div>
          <ul class="grid gap-2 sm:grid-cols-2">
            <li v-for="n in NEXT" :key="n.title">
              <a :href="n.href" class="block h-full rounded-lg border border-[var(--c-border)] px-3 py-2.5 hover:border-[var(--c-border-strong)] transition-colors" @click.prevent="trpc.setup.progress.mutate({ step: 'done' }).finally(() => router.replace(n.href))">
                <span class="block text-sm font-medium text-[var(--c-text-1)]">{{ n.title }}</span>
                <span class="mt-0.5 block text-xs text-[var(--c-text-3)]">{{ n.text }}</span>
              </a>
            </li>
          </ul>
          <div class="flex justify-end"><button class="btn btn-primary btn-sm" @click="goTo('done')">Go to the dashboard</button></div>
        </div>
      </div>
    </div>
  </div>
  <PlanDialog />
</template>
