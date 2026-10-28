<script setup lang="ts">
import { CircleAlertIcon, EyeIcon, EyeOffIcon } from '@lucide/vue'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { TRPCClientError } from '@trpc/client'
import { useAuth } from '../lib/auth'
import { trpc } from '../lib/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const router = useRouter()
const { login } = useAuth()

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const error = ref('')
const loading = ref(false)
const mounted = ref(false)

// No administrator yet, or a setup the admin has not finished (#12): the
// assistant comes first.
async function setupStep(): Promise<{ required: boolean; step: string | null } | null> {
  try { return await trpc.setup.status.query() } catch { return null }
}

onMounted(async () => {
  mounted.value = true
  const s = await setupStep()
  if (s?.required) void router.replace('/setup')
})

async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await login(username.value, password.value)
    const s = await setupStep()
    router.push(s?.step ? '/setup' : '/')
  } catch (err) {
    error.value = err instanceof TRPCClientError && err.data?.code === 'TOO_MANY_REQUESTS'
      ? err.message
      : 'Invalid username or password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-root min-h-screen flex items-center justify-center bg-background px-4 relative overflow-hidden">
    <!-- Ambient backdrop -->
    <div class="ambient" aria-hidden="true">
      <span class="glow glow-a"></span>
      <span class="glow glow-b"></span>
      <span class="glow glow-c"></span>
    </div>

    <div :class="['relative z-10 w-full max-w-sm login-card', mounted && 'is-in']">
      <div class="text-center mb-10">
        <div class="flex justify-center mb-4">
          <!-- Logo mark -->
          <svg class="w-12 h-12" viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <rect x="6" y="20" width="36" height="22" rx="4" fill="var(--primary)" opacity="0.12"/>
            <path d="M24 6 L42 20 H6 Z" fill="var(--primary)"/>
            <rect x="20" y="28" width="8" height="14" rx="1.5" fill="var(--primary)"/>
          </svg>
        </div>
        <div class="text-4xl font-semibold text-foreground mb-1">Home Server</div>
        <div class="eyebrow">Home Server Interface</div>
      </div>

      <form
        @submit.prevent="handleLogin"
        class="bg-card border border-input rounded-xl p-8 shadow-sm"
      >
        <div class="mb-5">
          <label for="login-username" class="eyebrow block mb-2">Username</label>
          <Input
            id="login-username"
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="Your username"
          />
        </div>

        <div class="mb-6">
          <label for="login-password" class="eyebrow block mb-2">Password</label>
          <div class="relative">
            <Input
              id="login-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              class="pr-10"
              placeholder="••••••••"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              @click="showPassword = !showPassword"
              :aria-label="showPassword ? 'Hide password' : 'Show password'"
              :aria-pressed="showPassword"
              class="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:bg-transparent"
            >
              <EyeIcon v-if="!showPassword" aria-hidden="true" />
              <EyeOffIcon v-else aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div v-if="error" role="alert" class="mb-4 flex items-center justify-center gap-1.5 text-sm text-primary">
          <CircleAlertIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
          {{ error }}
        </div>

        <Button
          type="submit"
          :disabled="loading"
          class="w-full justify-center"
        >
          {{ loading ? 'Signing in…' : 'Sign In' }}
        </Button>
      </form>

      <p class="text-center text-xs text-muted-foreground mt-6">
        Home Server Interface
      </p>
    </div>
  </div>
</template>

<style scoped>
.ambient {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.glow {
  position: absolute;
  border-radius: 9999px;
  filter: blur(80px);
  opacity: 0.5;
  will-change: transform;
}
.glow-a {
  width: 460px; height: 460px;
  top: -120px; left: -100px;
  background: var(--primary);
  animation: drift-a 26s ease-in-out infinite;
}
.glow-b {
  width: 380px; height: 380px;
  bottom: -140px; right: -80px;
  background: var(--primary);
  opacity: 0.35;
  animation: drift-b 32s ease-in-out infinite;
}
.glow-c {
  width: 300px; height: 300px;
  top: 40%; right: 20%;
  background: var(--info);
  opacity: 0.25;
  animation: drift-c 30s ease-in-out infinite;
}
/* Softer in light theme */
:root:not([data-theme="dark"]) .glow { opacity: 0.28; }
:root:not([data-theme="dark"]) .glow-b { opacity: 0.2; }
:root:not([data-theme="dark"]) .glow-c { opacity: 0.14; }

.login-card {
  opacity: 0;
  transform: scale(0.98) translateY(6px);
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.login-card.is-in {
  opacity: 1;
  transform: none;
}

@keyframes drift-a { 0%,100% { transform: translate(0,0); } 50% { transform: translate(40px,30px); } }
@keyframes drift-b { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-30px,-40px); } }
@keyframes drift-c { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-20px,25px); } }

@media (prefers-reduced-motion: reduce) {
  .glow { animation: none; }
  .login-card { transition: none; opacity: 1; transform: none; }
}
</style>
