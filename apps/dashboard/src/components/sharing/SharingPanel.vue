<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderIcon, ScrollTextIcon, SettingsIcon } from '@lucide/vue'
import SectionNav from '@/components/ui/SectionNav.vue'
import ServiceBanner from './ServiceBanner.vue'
import SharesSection from './SharesSection.vue'
import JournalSection from './JournalSection.vue'
import SettingsSection from './SettingsSection.vue'
import MySharesSection from './MySharesSection.vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import type { SharingService } from '../../lib/sharing-types'

const { t } = useI18n()
const { isAdmin } = useAuth()

type SectionId = 'shares' | 'journal' | 'settings'
const active = ref<SectionId>('shares')
const icons: Record<SectionId, Component> = { shares: FolderIcon, journal: ScrollTextIcon, settings: SettingsIcon }

// "See all" in a share opens the journal on that share.
const journalShare = ref<string | undefined>(undefined)
function openJournal(share: string) {
  journalShare.value = share
  active.value = 'journal'
}
const navItems = computed(() => (Object.keys(icons) as SectionId[]).map(id => ({ id, label: t(`sharing.nav.${id}`), icon: icons[id] })))

const service = ref<SharingService | null>(null)
const serviceLoading = ref(true)
let timer: ReturnType<typeof setInterval> | null = null

async function loadService() {
  serviceLoading.value = true
  try {
    service.value = await trpc.sharing.service.query()
  } catch {
    service.value = null
  } finally {
    serviceLoading.value = false
  }
}

onMounted(() => {
  if (!isAdmin.value) return
  void loadService()
  timer = setInterval(() => { if (!document.hidden) void loadService() }, 15000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div v-if="!isAdmin" class="h-full overflow-y-auto">
    <div class="max-w-3xl p-4 sm:p-8"><MySharesSection /></div>
  </div>
  <div v-else class="flex h-full flex-col sm:flex-row">
    <SectionNav v-model="active" :items="navItems" />
    <div class="flex-1 overflow-y-auto">
      <div class="max-w-5xl space-y-5 p-4 sm:p-8">
        <ServiceBanner :service="service" :loading="serviceLoading" @refresh="loadService" />
        <SharesSection v-if="active === 'shares'" :service="service" @changed="loadService" @see-all="openJournal" />
        <JournalSection v-else-if="active === 'journal'" :service="service" :initial-share="journalShare" />
        <SettingsSection v-else-if="active === 'settings'" :key="service?.settings.updatedAt?.toString()" :service="service" @changed="loadService" />
      </div>
    </div>
  </div>
</template>
