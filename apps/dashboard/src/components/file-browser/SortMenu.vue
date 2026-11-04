<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownUpIcon } from '@lucide/vue'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import Tip from '../ui/Tip.vue'
import { useFilePrefs } from '../../lib/file-prefs'
import { SORT_CHOICES, choiceFor } from '../../lib/file-sort'

// Toolbar menu for the listing's order and hidden files (#196); the visible
// columns and the default view are in the display settings it opens.
const emit = defineEmits<{ openDisplaySettings: [] }>()
const { t } = useI18n()
const { filePrefs, setFilePrefs, setSort } = useFilePrefs()

const choice = computed(() => choiceFor({ field: filePrefs.value.sortField, dir: filePrefs.value.sortDir }))

function choose(id: string) {
  const c = SORT_CHOICES.find(s => s.id === id)
  if (c) setSort(c.sort)
}
</script>

<template>
  <DropdownMenu>
    <!-- The tooltip wraps the trigger: a Button with its own tooltip is not the
         root element, so the menu would have nothing to anchor to. -->
    <Tip :text="t('files.sort.menu')">
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="sm" :aria-label="t('files.sort.menu')"
          class="px-2 text-base-content/70 data-[state=open]:bg-base-200 data-[state=open]:text-base-content">
          <ArrowDownUpIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
    </Tip>
    <DropdownMenuContent align="end" class="min-w-48">
      <DropdownMenuLabel>{{ t('files.sort.title') }}</DropdownMenuLabel>
      <DropdownMenuRadioGroup :model-value="choice" @update:model-value="choose">
        <DropdownMenuRadioItem v-for="c in SORT_CHOICES" :key="c.id" :value="c.id">{{ t(`files.sort.${c.id}`) }}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem :model-value="filePrefs.showHidden" @update:model-value="v => setFilePrefs({ showHidden: v })">
        {{ t('files.display.showHidden') }}
        <DropdownMenuShortcut>Ctrl+H</DropdownMenuShortcut>
      </DropdownMenuCheckboxItem>
      <DropdownMenuItem class="pl-8" @select="emit('openDisplaySettings')">{{ t('files.display.visibleColumns') }}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
