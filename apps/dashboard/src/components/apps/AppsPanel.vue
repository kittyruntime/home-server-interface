<script setup lang="ts">
import { ref } from 'vue'
import { useAuth } from '../../lib/auth'
import AppList from './AppList.vue'

const { isAdmin } = useAuth()

const appListRef = ref<InstanceType<typeof AppList> | null>(null)

function openNew() {
  appListRef.value?.openNew()
}

defineExpose({ openNew })
</script>

<template>
  <div class="flex h-full w-full">
    <div v-if="!isAdmin" class="flex items-center justify-center w-full text-[var(--c-text-3)] text-sm">
      Administrator access required.
    </div>
    <AppList v-else ref="appListRef" class="h-full w-full" />
  </div>
</template>
