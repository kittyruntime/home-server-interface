<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderIcon, ScrollTextIcon, ServerIcon, ShieldIcon } from '@lucide/vue'
import SectionNav from '@/components/ui/SectionNav.vue'
import SharesSection from './SharesSection.vue'
import JournalSection from './JournalSection.vue'
import FileServicesSection from './FileServicesSection.vue'
import SecuritySection from './SecuritySection.vue'
import MySharesSection from './MySharesSection.vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import type { SharingService } from '../../lib/sharing-types'

const { t } = useI18n()
const { isAdmin } = useAuth()

type SectionId = 'shares' | 'services' | 'security' | 'journal'
const active = ref<SectionId>('shares')
const icons: Record<SectionId, Component> = { shares: FolderIcon, services: ServerIcon, security: ShieldIcon, journal: ScrollTextIcon }

// "See all" in a share opens the journal on that share.
const journalShare = ref<string | undefined>(undefined)
function openJournal(share: string) {
  journalShare.value = share
  active.value = 'journal'
}
// The journal opens unfiltered from the menu; "See all" filters it once.
watch(active, v => { if (v !== 'journal') journalShare.value = undefined })
const navItems = computed(() => (Object.keys(icons) as SectionId[]).map(id => ({ id, label: t(`sharing.nav.${id}`), icon: icons[id] })))

const service = ref<SharingService | null>(null)
const serviceLoading = ref(true)
let timer: ReturnType<typeof setInterval> | null = null

async function loadService() {
  serviceLoading.value = true
  try {
    service.value = await trpc.sharing.service.query()
  } catch {
    // A failed poll (the service restarting) keeps what is on screen.
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
  <div v-if="!isAdmin" class="@container h-full overflow-y-auto">
    <div class="max-w-3xl p-4 @2xl:p-8"><MySharesSection /></div>
  </div>
  <div v-else class="@container h-full">
  <!-- The layout follows this panel's width (a desktop window or the
       classic view), not the screen's. -->
  <div class="flex h-full flex-col @2xl:flex-row">
    <SectionNav v-model="active" :items="navItems" container />
    <div class="flex-1 overflow-y-auto">
      <div class="max-w-5xl p-4 @2xl:p-8">
        <SharesSection v-if="active === 'shares'" :service="service" @changed="loadService" @see-all="openJournal" @open-services="active = 'services'" />
        <FileServicesSection v-else-if="active === 'services'" :service="service" :loading="serviceLoading" @changed="loadService" />
        <SecuritySection v-else-if="active === 'security'" :service="service" @changed="loadService" />
        <JournalSection v-else-if="active === 'journal'" :service="service" :initial-share="journalShare" />
      </div>
    </div>
  </div>
  </div>
</template>
