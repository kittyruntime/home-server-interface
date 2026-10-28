<script setup lang="ts">
import { ref } from 'vue'
import { PlusIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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

const open = ref(false)

function isBusy(id: string) {
  return props.busy?.[id] ?? false
}

function pick(id: string) {
  emit('add', id)
  open.value = false
}
</script>

<template>
  <div class="relative space-y-2">
    <div v-if="assigned.length > 0" class="space-y-0.5">
      <div
        v-for="item in assigned"
        :key="item.id"
        class="group flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-accent transition-colors"
      >
        <span
          v-if="item.avatarText"
          :class="['size-6 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-2xs font-bold shrink-0', item.avatarClass]"
        >{{ item.avatarText }}</span>
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
    <p v-else class="text-xs text-muted-foreground px-3">None assigned.</p>

    <Popover v-if="available.length > 0" v-model:open="open">
      <PopoverTrigger as-child>
        <Button variant="ghost" size="xs" class="ml-1 text-primary hover:text-primary">
          <PlusIcon />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList class="max-h-48">
            <CommandEmpty>No matches</CommandEmpty>
            <CommandItem
              v-for="item in available"
              :key="item.id"
              :value="item.id"
              @select="pick(item.id)"
            >
              <span
                v-if="item.avatarText"
                :class="['size-5 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-2xs font-bold shrink-0', item.avatarClass]"
              >{{ item.avatarText }}</span>
              <span class="truncate flex-1">{{ item.label }}</span>
              <span v-if="item.sublabel" class="text-2xs text-muted-foreground uppercase tracking-caps shrink-0">{{ item.sublabel }}</span>
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>
</template>
