<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuth } from '../../lib/auth'
import { useDockerStatus } from '../../lib/docker'
import AppList from './AppList.vue'
import DockerUnavailable from './DockerUnavailable.vue'

const { isAdmin } = useAuth()
const { check: checkDocker, ready: dockerReady } = useDockerStatus()
onMounted(() => { if (isAdmin.value) void checkDocker() })

const appListRef = ref<InstanceType<typeof AppList> | null>(null)

function openNew() {
  appListRef.value?.openNew()
}

defineExpose({ openNew })
</script>

<template>
  <div v-if="!isAdmin" class="flex items-center justify-center w-full h-full text-[var(--c-text-3)] text-sm">
    Administrator access required.
  </div>

  <DockerUnavailable v-else-if="!dockerReady()" />

  <AppList v-else ref="appListRef" class="h-full w-full" />
</template>
