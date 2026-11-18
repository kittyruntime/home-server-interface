<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import BusyLabel from '../ui/BusyLabel.vue'

// Pinned under the form while it holds unsaved changes.
defineProps<{ saving: boolean; invalid: boolean }>()
const emit = defineEmits<{ reset: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 rounded-box border border-base-300 bg-base-100 px-4 py-3 shadow-sm">
    <span class="mr-auto text-sm text-base-content/80" role="status">{{ t('sharing.settings.unsaved') }}</span>
    <Button type="button" variant="ghost" size="sm" :disabled="saving" @click="emit('reset')">{{ t('sharing.detail.cancel') }}</Button>
    <Button type="submit" size="sm" :disabled="invalid || saving">
      <BusyLabel :busy="saving">{{ t('sharing.settings.save') }}</BusyLabel>
    </Button>
  </div>
</template>
