<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'

const router = useRouter()
const { login } = useAuth()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

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
  <div class="min-h-screen flex items-center justify-center bg-[var(--c-bg)]">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <div class="text-4xl font-bold tracking-widest text-[var(--c-accent)] mb-1">Brume</div>
        <div class="text-slate-500 text-sm">Network Attached Storage</div>
      </div>

      <form
        @submit.prevent="handleLogin"
        class="bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl p-8 shadow-2xl"
      >
        <div class="mb-5">
          <label class="block text-slate-400 text-xs uppercase tracking-wider mb-2">
            Username
          </label>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            class="w-full bg-[var(--c-bg)] border border-[var(--c-border-strong)] rounded-lg px-4 py-2.5 text-[var(--c-text-3)]
                   focus:outline-none focus:border-[var(--c-accent)] transition-colors placeholder-slate-600"
            placeholder="admin"
          />
        </div>

        <div class="mb-6">
          <label class="block text-slate-400 text-xs uppercase tracking-wider mb-2">
            Password
          </label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="w-full bg-[var(--c-bg)] border border-[var(--c-border-strong)] rounded-lg px-4 py-2.5 text-[var(--c-text-3)]
                   focus:outline-none focus:border-[var(--c-accent)] transition-colors placeholder-slate-600"
            placeholder="••••••••"
          />
        </div>

        <div v-if="error" class="mb-4 text-red-400 text-sm text-center">
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-[var(--c-accent)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed
                 text-[var(--c-accent-fg)] font-medium rounded-lg py-2.5 transition-colors"
        >
          {{ loading ? 'Signing in…' : 'Sign In' }}
        </button>
      </form>
    </div>
  </div>
</template>
