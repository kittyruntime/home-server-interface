<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import EmptyState from './ui/EmptyState.vue'
import { Button } from '@/components/ui/button'

type Link = Awaited<ReturnType<typeof trpc.shareLink.listMine.query>>[number]
const links = ref<Link[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try { links.value = await trpc.shareLink.listMine.query() }
  finally { loading.value = false }
}
async function revoke(id: string) { await trpc.shareLink.revoke.mutate({ id }); await load() }
async function remove(id: string) { await trpc.shareLink.delete.mutate({ id }); await load() }

function status(l: Link) {
  if (l.disabled) return 'Revoked'
  if (l.expiresAt && new Date(l.expiresAt).getTime() < Date.now()) return 'Expired'
  if (l.maxDownloads != null && l.downloads >= l.maxDownloads) return 'Exhausted'
  return 'Active'
}
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-foreground">Shared links</h2>
      <p class="text-xs text-muted-foreground mt-1 max-w-md leading-relaxed">
        Public links you have created for files and folders. Anyone with a link can access it
        until it expires, hits its download limit, or you revoke it.
      </p>
    </div>

    <LoadingState v-if="loading && !links.length" variant="compact" />
    <div v-else-if="links.length === 0" class="rounded-xl border border-dashed border-input"><EmptyState message="No shared links yet." description="Share a file or folder from the file browser to create one." /></div>
    <div v-else class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden divide-y divide-border">
      <div v-for="l in links" :key="l.id" class="flex items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-0">
          <p class="text-sm text-foreground font-mono truncate">{{ l.path }}</p>
          <p class="text-xs text-muted-foreground">
            {{ status(l) }} · {{ l.downloads }}{{ l.maxDownloads != null ? '/' + l.maxDownloads : '' }} downloads
            <template v-if="l.hasPassword"> · 🔒</template>
          </p>
        </div>
        <Button variant="outline" size="xs" v-if="!l.disabled" @click="revoke(l.id)" class="shrink-0">Revoke</Button>
        <Button variant="destructive" size="xs" @click="remove(l.id)" class="shrink-0">Delete</Button>
      </div>
    </div>
  </div>
</template>
