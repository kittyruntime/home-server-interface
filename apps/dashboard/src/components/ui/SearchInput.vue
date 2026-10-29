<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { SearchIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

withDefaults(defineProps<{ modelValue: string; placeholder?: string }>(), {
  placeholder: 'Search…',
})
defineEmits<{ 'update:modelValue': [v: string] }>()
</script>

<template>
  <div class="relative">
    <SearchIcon class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
    <Input
      :model-value="modelValue"
      :placeholder="placeholder"
      class="pl-8 pr-8"
      @update:model-value="$emit('update:modelValue', String($event))"
    />
    <Button
      v-if="modelValue"
      variant="ghost"
      size="icon-xs"
      :tooltip="t('ui.shared.SearchInput.clear')"
      :aria-label="t('ui.shared.SearchInput.clearSearch')"
      class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      @click="$emit('update:modelValue', '')"
    >
      <XIcon />
    </Button>
  </div>
</template>
