<script setup lang="ts">
import type { Component } from 'vue'
import { ActivityIcon, FileTextIcon, FolderIcon, HardDriveIcon, LayoutGridIcon, SettingsIcon, Share2Icon, StoreIcon } from '@lucide/vue'
import type { AppId } from '../../lib/desktop'

// The glyph of an app (dock, launchpad, window title bars, sidebar), from the
// lucide set used by the shadcn-vue components.
const ICONS: Record<AppId, Component> = {
  files: FolderIcon,
  apps: LayoutGridIcon,
  settings: SettingsIcon,
  storage: HardDriveIcon,
  store: StoreIcon,
  monitor: ActivityIcon,
  sharing: Share2Icon,
  'file-preview': FileTextIcon,
}

withDefaults(defineProps<{ app: AppId; strokeWidth?: number }>(), { strokeWidth: 1.75 })
</script>

<template>
  <component :is="ICONS[app]" :stroke-width="strokeWidth" aria-hidden="true" />
</template>
