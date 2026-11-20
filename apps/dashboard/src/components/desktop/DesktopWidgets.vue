<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import WidgetBoard from '../widgets/WidgetBoard.vue'
import { canUse, widgetDef } from '../widgets/registry'
import { defaultBoards, useBoards } from '../../lib/dashboard-boards'
import { useAuth } from '../../lib/auth'

// The open board's widgets on the desktop, under the windows. The same boards
// as Overview; the desktop's context menu switches between them and edits.

const { t } = useI18n()
const { isAdmin, hasCapability } = useAuth()
const storageCap = hasCapability('storage')
const viewer = computed(() => ({ isAdmin: isAdmin.value, storage: storageCap.value }))
const store = useBoards()
const { loaded } = store

onMounted(() => {
  void store.load(() => defaultBoards(isAdmin.value, type => canUse(widgetDef(type), viewer.value), t('widgets.boards.defaultName')))
})
</script>

<template>
  <div class="p-6">
    <WidgetBoard v-if="loaded" :viewer="viewer" surface="desktop" />
  </div>
</template>
