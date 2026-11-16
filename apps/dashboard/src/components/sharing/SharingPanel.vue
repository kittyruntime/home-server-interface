<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderIcon } from '@lucide/vue'
import SectionNav from '@/components/ui/SectionNav.vue'
import ServiceBanner from './ServiceBanner.vue'
import SharesSection from './SharesSection.vue'
import { trpc } from '../../lib/trpc'
import type { SharingService } from '../../lib/sharing-types'

const { t } = useI18n()

type SectionId = 'shares'
const active = ref<SectionId>('shares')
const icons: Record<SectionId, Component> = { shares: FolderIcon }
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
  void loadService()
  timer = setInterval(() => { if (!document.hidden) void loadService() }, 15000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="flex h-full flex-col sm:flex-row">
    <SectionNav v-model="active" :items="navItems" />
    <div class="flex-1 overflow-y-auto">
      <div class="max-w-5xl space-y-5 p-4 sm:p-8">
        <ServiceBanner :service="service" :loading="serviceLoading" @refresh="loadService" />
        <SharesSection v-if="active === 'shares'" :service="service" @changed="loadService" />
      </div>
    </div>
  </div>
</template>
