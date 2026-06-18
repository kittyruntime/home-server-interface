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
  <div class="min-h-screen flex items-center justify-center bg-[var(--c-bg)] px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-10">
        <div class="text-5xl text-[var(--c-text-display)] mb-2" style="font-family: var(--font-display)">Home</div>
        <div class="eyebrow">Home Server Interface</div>
      </div>

      <form
        @submit.prevent="handleLogin"
        class="bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl p-8"
      >
        <div class="mb-5">
          <label class="eyebrow block mb-2">Username</label>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            class="ui-input"
            placeholder="admin"
          />
        </div>

        <div class="mb-6">
          <label class="eyebrow block mb-2">Password</label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="ui-input"
            placeholder="••••••••"
          />
        </div>

        <div v-if="error" class="mb-4 status-text text-[var(--c-accent)] text-center">
          [ERR] {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="btn btn-primary w-full justify-center"
        >
          {{ loading ? 'Signing in…' : 'Sign In' }}
        </button>
      </form>
    </div>
  </div>
</template>
