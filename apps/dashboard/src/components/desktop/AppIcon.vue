<script setup lang="ts">
import type { Component } from 'vue'
import { ActivityIcon, BellIcon, BotIcon, ContainerIcon, FileTextIcon, FolderIcon, HardDriveIcon, SettingsIcon, Share2Icon } from '@lucide/vue'
import type { AppId } from '../../lib/desktop'

// The glyph of an app (dock, launchpad, window title bars, sidebar), from the
// lucide set used across the interface.
const ICONS: Record<AppId, Component> = {
  'files': FolderIcon,
  'apps': ContainerIcon,
  'settings': SettingsIcon,
  'storage': HardDriveIcon,
  'monitor': ActivityIcon,
  'sharing': Share2Icon,
  'assistant': BotIcon,
  'file-preview': FileTextIcon,
  'activity': BellIcon,
}

withDefaults(defineProps<{ app: AppId; strokeWidth?: number }>(), { strokeWidth: 1.75 })
</script>

<template>
  <component :is="ICONS[app]" :stroke-width="strokeWidth" aria-hidden="true" />
</template>
