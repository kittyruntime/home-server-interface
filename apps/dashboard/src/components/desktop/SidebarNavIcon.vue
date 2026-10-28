<script setup lang="ts">
// The sidebar / mobile-nav glyph for a given app id. Kept as one component so the
// sidebar and bottom nav render identical icons from a data-driven list; apps
// use their AppIcon glyph, the overview its own.
import { LayoutDashboardIcon } from '@lucide/vue'
import type { AppId } from '../../lib/desktop'
import AppIcon from './AppIcon.vue'
defineProps<{ id: string }>()
</script>

<template>
  <LayoutDashboardIcon v-if="id === 'dashboard'" :stroke-width="1.75" class="size-5" aria-hidden="true" />
  <AppIcon v-else :app="id as AppId" :stroke-width="1.75" class="size-5" />
</template>
