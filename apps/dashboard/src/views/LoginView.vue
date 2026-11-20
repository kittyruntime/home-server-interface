<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CircleAlertIcon, EyeIcon, EyeOffIcon } from '@lucide/vue'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { TRPCClientError } from '@trpc/client'
import { useAuth } from '../lib/auth'
import { trpc } from '../lib/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import HsiMark from '../components/ui/HsiMark.vue'

const { t } = useI18n()

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
      : t('login.invalid')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-dvh flex items-center justify-center bg-base-200 px-4 py-10">
    <div :class="['w-full max-w-sm login-card', mounted && 'is-in']">
      <div class="mb-8 flex flex-col items-center text-center">
        <HsiMark class="size-11" />
        <h1 class="mt-5 text-2xl font-semibold tracking-tight text-base-content">{{ t('ui.views.LoginView.homeServer') }}</h1>
        <p class="mt-1 text-sm text-base-content/70">{{ t('ui.views.LoginView.homeServerInterface') }}</p>
      </div>

      <form
        @submit.prevent="handleLogin"
        class="rounded-box border border-base-300 bg-base-100 p-7"
      >
        <div class="mb-5">
          <label for="login-username" class="mb-2 block text-sm font-medium text-base-content">{{ t('login.username') }}</label>
          <Input
            id="login-username"
            v-model="username"
            type="text"
            autocomplete="username"
            :placeholder="t('login.usernamePlaceholder')"
          />
        </div>

        <div class="mb-6">
          <label for="login-password" class="mb-2 block text-sm font-medium text-base-content">{{ t('login.password') }}</label>
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
              :aria-label="showPassword ? t('login.hidePassword') : t('login.showPassword')"
              :aria-pressed="showPassword"
              class="absolute right-1 top-1/2 -translate-y-1/2 text-base-content/70 hover:bg-transparent"
            >
              <EyeIcon v-if="!showPassword" aria-hidden="true" />
              <EyeOffIcon v-else aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div v-if="error" role="alert" class="mb-4 flex items-center justify-center gap-1.5 text-sm text-error">
          <CircleAlertIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
          {{ error }}
        </div>

        <Button
          type="submit"
          :disabled="loading"
          class="w-full justify-center"
        >
          {{ loading ? t('login.signingIn') : t('login.signIn') }}
        </Button>
      </form>

    </div>
  </div>
</template>

<style scoped>
.login-card {
  opacity: 0;
  transform: translateY(6px);
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out);
}
.login-card.is-in {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .login-card { transition: none; opacity: 1; transform: none; }
}
</style>
