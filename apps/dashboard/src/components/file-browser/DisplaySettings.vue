<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFilePrefs } from '../../lib/file-prefs'
import { COLUMNS, type Column } from '../../lib/file-sort'

// The Display tab of the file manager's settings (#196).
const { t } = useI18n()
const { filePrefs, setFilePrefs } = useFilePrefs()

function toggleColumn(column: Column, on: boolean) {
  const next = on ? [...filePrefs.value.columns, column] : filePrefs.value.columns.filter(c => c !== column)
  setFilePrefs({ columns: next })
}
</script>

<template>
    <div class="space-y-6">
      <Card class="gap-0 py-0 shadow-none">
        <label class="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
          <span class="space-y-0.5">
            <span class="block text-sm font-medium">{{ t('files.display.showHidden') }}</span>
            <span class="block text-xs text-base-content/70">{{ t('files.display.showHiddenHint') }}</span>
          </span>
          <Switch :model-value="filePrefs.showHidden" @update:model-value="v => setFilePrefs({ showHidden: v })" />
        </label>
      </Card>

      <fieldset class="space-y-2">
        <legend class="mb-2 text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('files.display.view') }}</legend>
        <ToggleGroup type="single" variant="tabs" size="sm" :model-value="filePrefs.view" :aria-label="t('files.display.view')"
          @update:model-value="v => { if (v === 'list' || v === 'grid') setFilePrefs({ view: v }) }">
          <ToggleGroupItem value="list">{{ t('files.display.list') }}</ToggleGroupItem>
          <ToggleGroupItem value="grid">{{ t('files.display.grid') }}</ToggleGroupItem>
        </ToggleGroup>
      </fieldset>

      <fieldset>
        <legend class="mb-1 text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('files.display.columns') }}</legend>
        <p class="mb-2 text-xs text-base-content/70">{{ t('files.display.columnsHint') }}</p>
        <div class="flex flex-wrap gap-x-5 gap-y-2">
          <label v-for="c in COLUMNS" :key="c" class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox :model-value="filePrefs.columns.includes(c)" @update:model-value="v => toggleColumn(c, v === true)" />
            {{ t(`files.display.column.${c}`) }}
          </label>
        </div>
      </fieldset>
    </div>
</template>
