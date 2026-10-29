<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, onMounted } from 'vue'
import { useAuth } from '../../lib/auth'
import { useDockerStatus } from '../../lib/docker'
import AppList from './AppList.vue'
import DockerUnavailable from './DockerUnavailable.vue'

const { t } = useI18n()

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
  <div v-if="!isAdmin" class="flex items-center justify-center w-full h-full text-muted-foreground text-sm">
    {{ t('ui.apps.AppsPanel.administratorAccessRequired') }}
  </div>

  <DockerUnavailable v-else-if="!dockerReady()" />

  <AppList v-else ref="appListRef" class="h-full w-full" />
</template>
