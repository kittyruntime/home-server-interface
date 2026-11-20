<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRightIcon } from '@lucide/vue'
import { pathPart } from '../../lib/widget-expr'

// A source's value as a tree: a click on a key gives its path, so building an
// expression never needs typing one.

const props = defineProps<{ value: unknown; path?: string; name?: string | number; depth?: number }>()
const emit = defineEmits<{ pick: [path: string] }>()
const depth = props.depth ?? 0
const open = ref(depth < 2)

const isObj = computed(() => props.value !== null && typeof props.value === 'object')
const entries = computed(() => {
  if (!isObj.value) return []
  const all = Array.isArray(props.value) ? props.value.map((v, i) => [i, v] as const) : Object.entries(props.value as object)
  return all.slice(0, 50)
})
const more = computed(() => isObj.value ? (Array.isArray(props.value) ? props.value.length : Object.keys(props.value as object).length) - entries.value.length : 0)
const childPath = (k: string | number) => `${props.path ?? ''}${pathPart(k)}`
function preview(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`
  if (v && typeof v === 'object') return '{…}'
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}
</script>

<template>
  <div class="font-mono text-2xs">
    <div v-if="name !== undefined" class="flex items-center gap-1" :style="{ paddingLeft: `${depth * 0.75}rem` }">
      <button v-if="isObj" type="button" class="flex size-5 items-center justify-center rounded-selector text-base-content/60 hover:bg-base-300" :aria-expanded="open" :aria-label="String(name)" @click="open = !open">
        <ChevronRightIcon :class="['size-3 transition-transform duration-[var(--dur-fast)]', open && 'rotate-90']" aria-hidden="true" />
      </button>
      <span v-else class="size-5" />
      <button type="button" class="rounded-selector px-1 text-left text-base-content hover:bg-primary/15" @click="emit('pick', path ?? '')">{{ name }}</button>
      <span class="truncate text-base-content/60">{{ preview(value) }}</span>
    </div>
    <template v-if="isObj && (open || name === undefined)">
      <JsonTree v-for="[k, v] in entries" :key="k" :value="v" :name="k" :path="childPath(k)" :depth="name === undefined ? depth : depth + 1" @pick="p => emit('pick', p)" />
      <p v-if="more > 0" class="text-base-content/50" :style="{ paddingLeft: `${(depth + 1) * 0.75 + 1.5}rem` }">+{{ more }}</p>
    </template>
    <p v-else-if="name === undefined" class="text-base-content/70">{{ preview(value) }}</p>
  </div>
</template>
