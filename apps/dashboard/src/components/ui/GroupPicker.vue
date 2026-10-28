<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { pushEscLayer } from '../../lib/escLayer'
import { Input } from '@/components/ui/input'

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
const search = ref('')
const rootRef = ref<HTMLDivElement | null>(null)

const filteredAvailable = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.available
  return props.available.filter(i =>
    i.label.toLowerCase().includes(q) || (i.sublabel ?? '').toLowerCase().includes(q),
  )
})

function isBusy(id: string) {
  return props.busy?.[id] ?? false
}

/* The open dropdown registers as an Escape layer so Escape closes it without
   also dismissing the modal it lives in. */
let releaseEsc: (() => void) | null = null

function openPicker() {
  open.value = true
  search.value = ''
  releaseEsc ??= pushEscLayer(closePicker)
}
function closePicker() {
  open.value = false
  releaseEsc?.()
  releaseEsc = null
}
function togglePicker() {
  if (open.value) closePicker()
  else openPicker()
}

function pick(id: string) {
  emit('add', id)
  closePicker()
}

function onDocMousedown(e: MouseEvent) {
  if (!open.value) return
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) closePicker()
}
onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMousedown)
  releaseEsc?.()
  releaseEsc = null
})
</script>

<template>
  <div ref="rootRef" class="relative space-y-2">
    <div v-if="assigned.length > 0" class="space-y-0.5">
      <div
        v-for="item in assigned"
        :key="item.id"
        class="group flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-accent transition-colors"
      >
        <span
          v-if="item.avatarText"
          :class="['w-6 h-6 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-2xs font-bold shrink-0', item.avatarClass]"
        >{{ item.avatarText }}</span>
        <span v-else class="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />

        <span class="flex-1 min-w-0 flex items-baseline gap-2">
          <span class="text-sm font-medium text-foreground truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="text-2xs text-muted-foreground uppercase tracking-caps shrink-0">{{ item.sublabel }}</span>
        </span>

        <button
          :disabled="item.disabled || isBusy(item.id)"
          @click="emit('remove', item.id)"
          :title="item.disabled ? 'Cannot remove' : 'Remove'"
          :class="[
            'p-1 rounded-sm transition-all shrink-0',
            item.disabled
              ? 'opacity-30 cursor-not-allowed text-muted-foreground'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed',
          ]"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
    <p v-else class="text-xs text-muted-foreground px-3">None assigned.</p>

    <button
      v-if="available.length > 0"
      @click="togglePicker"
      class="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-colors px-3"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
      </svg>
      Add
    </button>

    <div
      v-if="open"
      class="absolute z-20 left-0 top-full mt-1 w-64 bg-card border border-input rounded-xl shadow-lg overflow-hidden"
    >
      <div class="p-2 border-b border-border">
        <div class="relative">
          <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>
          </svg>
          <Input v-model="search" autofocus placeholder="Search…" class="pl-8"/>
        </div>
      </div>
      <div class="max-h-48 overflow-y-auto py-1">
        <button
          v-for="item in filteredAvailable"
          :key="item.id"
          @click="pick(item.id)"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent transition-colors"
        >
          <span
            v-if="item.avatarText"
            :class="['w-5 h-5 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-2xs font-bold shrink-0', item.avatarClass]"
          >{{ item.avatarText }}</span>
          <span class="text-sm text-foreground/80 truncate flex-1">{{ item.label }}</span>
          <span v-if="item.sublabel" class="text-2xs text-muted-foreground uppercase tracking-caps shrink-0">{{ item.sublabel }}</span>
        </button>
        <p v-if="filteredAvailable.length === 0" class="px-3 py-2 text-xs text-muted-foreground">No matches</p>
      </div>
    </div>
  </div>
</template>
