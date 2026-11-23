<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { defineAsyncComponent, nextTick, onMounted, ref } from 'vue'
import { useAuth } from '../../lib/auth'
import { useDockerStatus } from '../../lib/docker'
import { appsView, showAppsView, type AppsView } from '../../lib/apps-view'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PanelSkeleton } from '@/components/ui/skeleton'
import AppList from './AppList.vue'
import DockerUnavailable from './DockerUnavailable.vue'

// One app for everything about apps: the ones this server runs, and the App
// Store to add more. A segmented control switches between the two; both stay
// alive once shown, so switching back is instant and keeps the scroll, the
// search and the page that was open.
const loadStore = () => import('../store/AppStorePanel.vue')
const AppStorePanel = defineAsyncComponent({ loader: loadStore, loadingComponent: PanelSkeleton, delay: 0 })

const { t } = useI18n()

const { isAdmin } = useAuth()
const { check: checkDocker, ready: dockerReady } = useDockerStatus()
onMounted(() => {
  if (!isAdmin.value) return
  void checkDocker()
  // Warm the store's code while nothing happens, so its first opening is instant.
  const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 500)
  idle(() => { void loadStore() })
})

const appListRef = ref<InstanceType<typeof AppList> | null>(null)

async function openNew() {
  showAppsView('installed')
  await nextTick()
  appListRef.value?.openNew()
}

function onView(v: unknown) {
  if (v === 'installed' || v === 'store') showAppsView(v as AppsView)
}

defineExpose({ openNew })
</script>

<template>
  <div v-if="!isAdmin" class="flex items-center justify-center w-full h-full text-base-content/70 text-sm">
    {{ t('ui.apps.AppsPanel.administratorAccessRequired') }}
  </div>

  <DockerUnavailable v-else-if="!dockerReady()" />

  <div v-else class="flex h-full w-full flex-col">
    <div class="shrink-0 border-b border-base-300 bg-base-100 px-4 py-2.5 sm:px-8">
      <ToggleGroup
        type="single" variant="tabs" size="sm"
        :aria-label="t('ui.apps.AppsPanel.view')"
        :model-value="appsView"
        class="mx-auto w-fit"
        @update:model-value="onView"
      >
        <ToggleGroupItem value="installed" class="min-w-28">{{ t('ui.apps.AppsPanel.installed') }}</ToggleGroupItem>
        <ToggleGroupItem value="store" class="min-w-28">{{ t('ui.apps.AppsPanel.appStore') }}</ToggleGroupItem>
      </ToggleGroup>
    </div>
    <div class="min-h-0 flex-1">
      <KeepAlive>
        <AppList v-if="appsView === 'installed'" ref="appListRef" class="h-full w-full" @browse-store="showAppsView('store')" />
        <AppStorePanel v-else class="h-full w-full" />
      </KeepAlive>
    </div>
  </div>
</template>
