<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

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
      <h2 class="text-base font-semibold text-[var(--c-text-1)]">Shared links</h2>
      <p class="text-xs text-[var(--c-text-3)] mt-1 max-w-md leading-relaxed">
        Public links you have created for files and folders. Anyone with a link can access it
        until it expires, hits its download limit, or you revoke it.
      </p>
    </div>

    <div v-if="loading" class="text-[var(--c-text-3)] text-sm">Loading…</div>
    <div v-else-if="links.length === 0" class="rounded-xl border border-dashed border-[var(--c-border-strong)] px-6 py-8 text-center text-sm text-[var(--c-text-3)]">
      No shared links yet.
    </div>
    <div v-else class="panel-card divide-y divide-[var(--c-border)]">
      <div v-for="l in links" :key="l.id" class="flex items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-0">
          <p class="text-sm text-[var(--c-text-1)] font-mono truncate">{{ l.path }}</p>
          <p class="text-xs text-[var(--c-text-3)]">
            {{ status(l) }} · {{ l.downloads }}{{ l.maxDownloads != null ? '/' + l.maxDownloads : '' }} downloads
            <template v-if="l.hasPassword"> · 🔒</template>
          </p>
        </div>
        <button v-if="!l.disabled" @click="revoke(l.id)" class="btn btn-outline btn-xs shrink-0">Revoke</button>
        <button @click="remove(l.id)" class="btn btn-danger btn-xs shrink-0">Delete</button>
      </div>
    </div>
  </div>
</template>
