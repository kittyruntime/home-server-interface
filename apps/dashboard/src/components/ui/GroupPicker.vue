<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { PlusIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { nextIndex } from '@/lib/menu-navigation'
import { matchesQuery } from '@/lib/search-match'
import { useAnchoredPopover } from '@/lib/use-anchored-popover'

const { t } = useI18n()

export type PickerItem = {
  id: string
  label: string
  sublabel?: string
  disabled?: boolean
  avatarText?: string
  avatarClass?: string
}

const props = defineProps<{
  assigned: PickerItem[]
  available: PickerItem[]
  busy?: Record<string, boolean>
}>()
const emit = defineEmits<{ add: [id: string]; remove: [id: string] }>()

function isBusy(id: string) {
  return props.busy?.[id] ?? false
}

const listId = useId()
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const active = ref(-1)

const { floating, open, close, isOpen } = useAnchoredPopover({
  placement: 'bottom-start',
  dismiss: true,
  captureEscape: true,
  closeOnFocusOutside: true,
  onPlaced: () => input.value?.focus({ preventScroll: true }),
})

const filtered = computed(() => {
  return props.available.filter(item => matchesQuery(query.value, item.label, item.sublabel))
})

watch([query, isOpen], () => { active.value = filtered.value.length > 0 ? 0 : -1 })

function optionId(index: number) {
  return `${listId}-${index}`
}

function toggle(event: MouseEvent) {
  if (isOpen.value) { close(); return }
  query.value = ''
  open(event.currentTarget as HTMLElement)
}

function pick(id: string) {
  emit('add', id)
  close()
}

/* A press on the box's padding or text must not move focus out of the input
   (a modal around it would treat that as leaving, and close the picker). */
function onBoxMousedown(event: MouseEvent) {
  if (event.target !== input.value) event.preventDefault()
}

function onKeydown(event: KeyboardEvent) {
  // Leaving the list by Tab closes it; focus goes back to the trigger first.
  if (event.key === 'Tab') { close(); return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    active.value = nextIndex(event.key, active.value, filtered.value.map(() => false))
    void nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView({ block: 'nearest' }))
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = filtered.value[active.value]
    if (item) pick(item.id)
  }
}
</script>

<template>
  <div class="relative space-y-2">
    <div v-if="assigned.length > 0" class="space-y-0.5">
      <div
        v-for="item in assigned"
        :key="item.id"
        class="group flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-base-200 transition-colors"
      >
        <Avatar v-if="item.avatarText" class="size-6 text-2xs">
          <AvatarFallback :class="['bg-gradient-to-br font-bold text-white', item.avatarClass]">{{ item.avatarText }}</AvatarFallback>
        </Avatar>
        <span v-else class="size-1.5 rounded-full bg-primary shrink-0" />

        <span class="flex-1 min-w-0 flex items-baseline gap-2">
          <span class="text-sm font-medium text-foreground truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="text-2xs text-muted-foreground uppercase tracking-caps shrink-0">{{ item.sublabel }}</span>
        </span>

        <Button
          variant="ghost"
          size="icon-xs"
          :disabled="item.disabled || isBusy(item.id)"
          :title="item.disabled ? 'Cannot remove' : 'Remove'"
          :aria-label="`Remove ${item.label}`"
          :class="[
            'shrink-0 text-muted-foreground',
            item.disabled ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive',
          ]"
          @click="emit('remove', item.id)"
        >
          <XIcon />
        </Button>
      </div>
    </div>
    <p v-else class="text-xs text-muted-foreground px-3">{{ t('ui.shared.GroupPicker.noneAssigned') }}</p>

    <template v-if="available.length > 0">
      <Button
        variant="ghost"
        size="xs"
        class="ml-1 text-primary hover:text-primary"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        :aria-controls="isOpen ? `${listId}-box` : undefined"
        @click="toggle"
      >
        <PlusIcon />
        {{ t('ui.shared.GroupPicker.add') }}
      </Button>
      <div
        v-if="isOpen"
        :id="`${listId}-box`"
        :ref="(el) => { floating = el as HTMLElement | null }"
        popover="manual"
        data-dismissable-layer
        @mousedown="onBoxMousedown"
        class="bg-base-100 text-base-content z-50 w-64 max-w-[calc(100vw-1rem)] rounded-box border border-base-300 shadow-md"
      >
        <div class="border-b border-base-300 p-2">
          <input
            ref="input"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            :aria-controls="listId"
            :aria-activedescendant="active >= 0 ? optionId(active) : undefined"
            :aria-label="t('ui.shared.GroupPicker.search')"
            :placeholder="t('ui.shared.GroupPicker.search')"
            class="input input-sm w-full"
            @keydown="onKeydown"
          >
        </div>
        <ul :id="listId" role="listbox" tabindex="-1" class="menu max-h-48 w-full flex-nowrap overflow-y-auto p-1">
          <li v-if="filtered.length === 0" role="none" class="menu-disabled">
            <span class="justify-center">{{ t('ui.shared.GroupPicker.noMatches') }}</span>
          </li>
          <li v-for="(item, index) in filtered" :key="item.id" role="none">
            <button
              :id="optionId(index)"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="index === active"
              :class="['flex items-center gap-2', index === active ? 'bg-base-content/10' : '']"
              @pointermove="active = index"
              @mousedown.prevent
              @click="pick(item.id)"
            >
              <Avatar v-if="item.avatarText" class="size-5 text-2xs">
                <AvatarFallback :class="['bg-gradient-to-br font-bold text-white', item.avatarClass]">{{ item.avatarText }}</AvatarFallback>
              </Avatar>
              <span class="truncate flex-1">{{ item.label }}</span>
              <span v-if="item.sublabel" class="text-2xs text-muted-foreground uppercase tracking-caps shrink-0">{{ item.sublabel }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
