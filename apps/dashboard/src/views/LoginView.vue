<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'

const router = useRouter()
const { login } = useAuth()

const username = ref('')
const password = ref('')
const showPassword = ref(false)
const error = ref('')
const loading = ref(false)
const mounted = ref(false)
const appVersion = __APP_VERSION__

onMounted(() => { mounted.value = true })

async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await login(username.value, password.value)
    router.push('/')
  } catch {
    error.value = 'Invalid username or password'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-root min-h-screen flex items-center justify-center bg-[var(--c-bg)] px-4 relative overflow-hidden">
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
            <rect x="6" y="20" width="36" height="22" rx="4" fill="var(--c-accent)" opacity="0.12"/>
            <path d="M24 6 L42 20 H6 Z" fill="var(--c-accent)"/>
            <rect x="20" y="28" width="8" height="14" rx="1.5" fill="var(--c-accent)"/>
          </svg>
        </div>
        <div class="text-4xl font-semibold text-[var(--c-text-display)] mb-1">Home Server</div>
        <div class="eyebrow">Home Server Interface</div>
      </div>

      <form
        @submit.prevent="handleLogin"
        class="bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl p-8 shadow-sm"
      >
        <div class="mb-5">
          <label for="login-username" class="eyebrow block mb-2">Username</label>
          <input
            id="login-username"
            v-model="username"
            type="text"
            autocomplete="username"
            class="ui-input"
            placeholder="admin"
          />
        </div>

        <div class="mb-6">
          <label for="login-password" class="eyebrow block mb-2">Password</label>
          <div class="relative">
            <input
              id="login-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              class="ui-input pr-10"
              placeholder="••••••••"
            />
            <button
              type="button"
              @click="showPassword = !showPassword"
              :aria-label="showPassword ? 'Hide password' : 'Show password'"
              :aria-pressed="showPassword"
              class="absolute inset-y-0 right-0 flex items-center px-3 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors"
            >
              <svg v-if="!showPassword" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L9.88 9.88"/>
              </svg>
            </button>
          </div>
        </div>

        <div v-if="error" role="alert" class="mb-4 flex items-center justify-center gap-1.5 text-sm text-[var(--c-accent)]">
          <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="btn btn-primary w-full justify-center"
        >
          {{ loading ? 'Signing in…' : 'Sign In' }}
        </button>
      </form>

      <p class="text-center text-xs text-[var(--c-text-3)] mt-6">
        Home Server Interface · v{{ appVersion }}
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
  background: var(--c-accent);
  animation: drift-a 26s ease-in-out infinite;
}
.glow-b {
  width: 380px; height: 380px;
  bottom: -140px; right: -80px;
  background: var(--c-accent);
  opacity: 0.35;
  animation: drift-b 32s ease-in-out infinite;
}
.glow-c {
  width: 300px; height: 300px;
  top: 40%; right: 20%;
  background: var(--c-info);
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
