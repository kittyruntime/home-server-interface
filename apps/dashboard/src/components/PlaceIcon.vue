<script setup lang="ts">
import { FolderIcon, ServerIcon } from '@lucide/vue'

// A place's emoji when it has one, else the folder icon (the server icon for
// the virtual root). Sized by the caller like a Lucide icon.
defineProps<{ icon?: string | null; root?: boolean }>()
</script>

<template>
  <span v-if="icon" aria-hidden="true" class="inline-flex shrink-0 items-center justify-center leading-none">{{ icon }}</span>
  <ServerIcon v-else-if="root" aria-hidden="true" />
  <FolderIcon v-else aria-hidden="true" />
</template>
