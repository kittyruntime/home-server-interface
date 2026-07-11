<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { trpc } from '../lib/trpc'

const route = useRoute()
const token = route.params.token as string

type Info = Awaited<ReturnType<typeof trpc.shareLink.info.query>>
const info = ref<Info | null>(null)
const loading = ref(true)
const password = ref('')
const accessToken = ref<string | null>(null)
const unlockError = ref('')
const loadError = ref('')
const subPath = ref('')
const entries = ref<{ name: string; type: 'dir' | 'file'; size: number | null }[]>([])

function fmtBytes(n: number | null | undefined) {
  if (n == null) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function downloadUrl(relPath: string, inline = false) {
  const p = new URLSearchParams()
  if (relPath) p.set('path', relPath)
  if (accessToken.value) p.set('access', accessToken.value)
  if (inline) p.set('inline', '1')
  return `/s/${token}/download?${p.toString()}`
}

async function loadInfo() {
  loading.value = true
  loadError.value = ''
  try { info.value = await trpc.shareLink.info.query({ token, accessToken: accessToken.value ?? undefined }) }
  catch { loadError.value = 'Something went wrong. Please try again.' }
  finally { loading.value = false }
}

async function submitPassword() {
  unlockError.value = ''
  try {
    const r = await trpc.shareLink.unlock.mutate({ token, password: password.value })
    accessToken.value = r.accessToken
    await loadInfo()          // info now returns kind/name/size
    const i = info.value
    if (i && i.state === 'ok' && 'kind' in i && i.kind === 'dir') {
      await loadDir('')
    }
  } catch { unlockError.value = 'Wrong password' }
}

async function loadDir(path: string) {
  subPath.value = path
  loadError.value = ''
  try {
    const r = await trpc.shareLink.browse.query({ token, subPath: path, accessToken: accessToken.value ?? undefined })
    entries.value = r.entries
  } catch { loadError.value = 'Could not open this folder.' }
}

const crumbs = computed(() => subPath.value ? subPath.value.split('/').filter(Boolean) : [])

onMounted(async () => {
  await loadInfo()
  const i = info.value
  if (i && i.state === 'ok' && 'kind' in i && i.kind === 'dir') await loadDir('')
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-[var(--c-bg)] p-4">
    <div class="w-full max-w-lg panel-card p-6 bg-[var(--c-surface)]">
      <p v-if="loadError && !loading" class="text-sm text-[var(--c-accent)] mb-3">{{ loadError }}</p>

      <div v-if="loading" class="text-[var(--c-text-3)] text-sm">Loading…</div>

      <!-- Unavailable states -->
      <div v-else-if="info && info.state !== 'ok'" class="text-center py-8">
        <h2 class="text-base font-semibold text-[var(--c-text-1)]">Link unavailable</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-1">
          {{ info.state === 'expired' ? 'This link has expired.'
            : info.state === 'exhausted' ? 'This link has reached its download limit.'
            : info.state === 'disabled' ? 'This link has been revoked.'
            : 'This link does not exist.' }}
        </p>
      </div>

      <!-- Password gate -->
      <form v-else-if="info?.needsPassword" @submit.prevent="submitPassword" class="space-y-3">
        <h2 class="text-base font-semibold text-[var(--c-text-1)]">Password required</h2>
        <input v-model="password" type="password" class="ui-input" placeholder="Enter password" autofocus />
        <p v-if="unlockError" class="text-[var(--c-accent)] text-xs">{{ unlockError }}</p>
        <button type="submit" class="btn btn-primary btn-sm">Unlock</button>
      </form>

      <!-- File -->
      <div v-else-if="info && info.state === 'ok' && 'kind' in info && info.kind === 'file'" class="text-center space-y-4">
        <h2 class="text-base font-semibold text-[var(--c-text-1)] break-all">{{ info.name }}</h2>
        <p class="text-xs text-[var(--c-text-3)]">{{ fmtBytes(info.size) }}</p>
        <a :href="downloadUrl('')" class="btn btn-primary btn-sm mx-auto">Download</a>
      </div>

      <!-- Folder -->
      <div v-else-if="info && info.state === 'ok' && 'kind' in info && info.kind === 'dir'" class="space-y-3">
        <div class="flex items-center gap-1 text-xs text-[var(--c-text-3)] flex-wrap">
          <button class="hover:text-[var(--c-text-1)]" @click="loadDir('')">{{ info.name }}</button>
          <template v-for="(c, i) in crumbs" :key="i">
            <span>/</span>
            <button class="hover:text-[var(--c-text-1)]" @click="loadDir(crumbs.slice(0, i + 1).join('/'))">{{ c }}</button>
          </template>
        </div>
        <ul class="divide-y divide-[var(--c-border)]">
          <li v-for="e in entries" :key="e.name" class="flex items-center justify-between py-2 text-sm">
            <button v-if="e.type === 'dir'" class="text-left text-[var(--c-text-1)] hover:text-[var(--c-accent)]"
              @click="loadDir((subPath ? subPath + '/' : '') + e.name)">📁 {{ e.name }}</button>
            <span v-else class="text-[var(--c-text-2)] truncate">{{ e.name }}</span>
            <a v-if="e.type === 'file'" :href="downloadUrl((subPath ? subPath + '/' : '') + e.name)"
              class="btn btn-outline btn-xs shrink-0">Download</a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
