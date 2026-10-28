<script setup lang="ts">
import { Card } from '@/components/ui/card'
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { trpc } from '../lib/trpc'
import LoadingState from '../components/ui/LoadingState.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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

// Downloads the whole shared folder as one archive (always the share root).
function zipUrl() {
  return `/s/${token}/zip${accessToken.value ? '?access=' + accessToken.value : ''}`
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
  <div class="min-h-screen flex items-center justify-center bg-background p-4">
    <Card class="block gap-0 py-0 overflow-hidden w-full max-w-lg p-6">
      <p v-if="loadError && !loading" class="text-sm text-primary mb-3">{{ loadError }}</p>

      <LoadingState v-if="loading" variant="compact" />

      <!-- Unavailable states -->
      <div v-else-if="info && info.state !== 'ok'" class="text-center py-8">
        <h2 class="text-base font-semibold text-foreground">Link unavailable</h2>
        <p class="text-sm text-muted-foreground mt-1">
          {{ info.state === 'expired' ? 'This link has expired.'
            : info.state === 'exhausted' ? 'This link has reached its download limit.'
            : info.state === 'disabled' ? 'This link has been revoked.'
            : 'This link does not exist.' }}
        </p>
      </div>

      <!-- Password gate -->
      <form v-else-if="info?.needsPassword" @submit.prevent="submitPassword" class="space-y-3">
        <h2 class="text-base font-semibold text-foreground">Password required</h2>
        <Input v-model="password" type="password" placeholder="Enter password" autofocus />
        <p v-if="unlockError" class="text-primary text-xs">{{ unlockError }}</p>
        <Button size="sm" type="submit">Unlock</Button>
      </form>

      <!-- File -->
      <div v-else-if="info && info.state === 'ok' && 'kind' in info && info.kind === 'file'" class="text-center space-y-4">
        <h2 class="text-base font-semibold text-foreground break-all">{{ info.name }}</h2>
        <p class="text-xs text-muted-foreground">{{ fmtBytes(info.size) }}</p>
        <Button as="a" size="sm" :href="downloadUrl('')" class="mx-auto">Download</Button>
      </div>

      <!-- Folder -->
      <div v-else-if="info && info.state === 'ok' && 'kind' in info && info.kind === 'dir'" class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-1 text-xs text-muted-foreground flex-wrap min-w-0">
            <Button variant="link" class="h-auto p-0 hover:text-foreground" @click="loadDir('')">{{ info.name }}</Button>
            <template v-for="(c, i) in crumbs" :key="i">
              <span>/</span>
              <Button variant="link" class="h-auto p-0 hover:text-foreground" @click="loadDir(crumbs.slice(0, i + 1).join('/'))">{{ c }}</Button>
            </template>
          </div>
          <Button as="a" variant="outline" size="xs" :href="zipUrl()" class="shrink-0">Download all as .zip</Button>
        </div>
        <ul class="divide-y divide-border">
          <li v-for="e in entries" :key="e.name" class="flex items-center justify-between py-2 text-sm">
            <Button variant="link" v-if="e.type === 'dir'" class="h-auto p-0 text-left text-foreground hover:text-primary"
              @click="loadDir((subPath ? subPath + '/' : '') + e.name)">📁 {{ e.name }}</Button>
            <span v-else class="text-foreground/80 truncate">{{ e.name }}</span>
            <Button as="a" variant="outline" size="xs" v-if="e.type === 'file'" :href="downloadUrl((subPath ? subPath + '/' : '') + e.name)"
              class="shrink-0">Download</Button>
          </li>
        </ul>
      </div>
    </Card>
  </div>
</template>
