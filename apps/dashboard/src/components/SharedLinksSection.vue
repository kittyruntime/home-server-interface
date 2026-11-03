<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import EmptyState from './ui/EmptyState.vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

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
  if (l.disabled) return t('uis.settings.SharedLinksSection.revoked')
  if (l.expiresAt && new Date(l.expiresAt).getTime() < Date.now()) return t('uis.settings.SharedLinksSection.expired')
  if (l.maxDownloads != null && l.downloads >= l.maxDownloads) return t('uis.settings.SharedLinksSection.exhausted')
  return t('uis.settings.SharedLinksSection.active')
}
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('ui.settings.SharedLinksSection.sharedLinks') }}</h2>
      <p class="text-xs text-base-content/70 mt-1 max-w-md leading-relaxed">
        {{ t('ui.settings.SharedLinksSection.publicLinksYouHaveCreated') }}
      </p>
    </div>

    <LoadingState v-if="loading && !links.length" variant="compact" />
    <div v-else-if="links.length === 0" class="rounded-xl border border-dashed border-base-300"><EmptyState :message="t('ui.settings.SharedLinksSection.noSharedLinksYet')" :description="t('ui.settings.SharedLinksSection.shareAFileOrFolder')" /></div>
    <Card v-else class="block gap-0 py-0 overflow-hidden divide-y divide-base-300">
      <div v-for="l in links" :key="l.id" class="flex items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-0">
          <p class="text-sm text-base-content font-mono truncate">{{ l.path }}</p>
          <p class="text-xs text-base-content/70">
            {{ t('uip.settings.SharedLinksSection.downloads', { p0: status(l), p1: l.downloads, p2: l.maxDownloads != null ? '/' + l.maxDownloads : '' }) }}
            <template v-if="l.hasPassword"> · 🔒</template>
          </p>
        </div>
        <Button variant="outline" size="xs" v-if="!l.disabled" @click="revoke(l.id)" class="shrink-0">{{ t('ui.settings.SharedLinksSection.revoke') }}</Button>
        <Button variant="destructive" size="xs" @click="remove(l.id)" class="shrink-0">{{ t('ui.settings.SharedLinksSection.delete') }}</Button>
      </div>
    </Card>
  </div>
</template>
