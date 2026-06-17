<script setup lang="ts">
import { ref } from 'vue'

export interface AdvancedConfig {
  capAdd:        string[]
  capDrop:       string[]
  restartPolicy: string
  hostname:      string | null
  user:          string | null
  command:       string | null
  cpuLimit:      number | null
  memoryLimit:   string | null
}

const props = defineProps<{ modelValue: AdvancedConfig }>()
const emit  = defineEmits<{ 'update:modelValue': [v: AdvancedConfig] }>()

const capAddInput  = ref('')
const capDropInput = ref('')

function update(field: keyof AdvancedConfig, val: unknown) {
  emit('update:modelValue', { ...props.modelValue, [field]: val })
}

function addCap(field: 'capAdd' | 'capDrop', inputRef: { value: string }) {
  const cap = inputRef.value.trim().toUpperCase()
  if (!cap) return
  if (!props.modelValue[field].includes(cap)) {
    update(field, [...props.modelValue[field], cap])
  }
  inputRef.value = ''
}

function removeCap(field: 'capAdd' | 'capDrop', cap: string) {
  update(field, props.modelValue[field].filter(c => c !== cap))
}
</script>

<template>
  <div class="space-y-5">

    <!-- Cap Add -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Cap Add</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span
          v-for="cap in modelValue.capAdd" :key="cap"
          class="inline-flex items-center gap-1 text-xs bg-[var(--c-accent-subtle)] text-[var(--c-accent)] border border-[var(--c-border-strong)] rounded px-2 py-0.5"
        >
          {{ cap }}
          <button @click="removeCap('capAdd', cap)" class="hover:opacity-60 transition-colors">×</button>
        </span>
      </div>
      <div class="flex gap-2">
        <input
          v-model="capAddInput" placeholder="NET_ADMIN" @keydown.enter.prevent="addCap('capAdd', capAddInput as any)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <button
          @click="addCap('capAdd', capAddInput as any)"
          class="px-3 py-1.5 bg-[var(--c-accent-subtle)] text-[var(--c-accent)] rounded-lg text-sm hover:opacity-80 transition-colors"
        >Add</button>
      </div>
    </div>

    <!-- Cap Drop -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Cap Drop</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span
          v-for="cap in modelValue.capDrop" :key="cap"
          class="inline-flex items-center gap-1 text-xs bg-amber-600/15 text-amber-300 border border-amber-500/20 rounded px-2 py-0.5"
        >
          {{ cap }}
          <button @click="removeCap('capDrop', cap)" class="hover:text-amber-100 transition-colors">×</button>
        </span>
      </div>
      <div class="flex gap-2">
        <input
          v-model="capDropInput" placeholder="ALL" @keydown.enter.prevent="addCap('capDrop', capDropInput as any)"
          class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <button
          @click="addCap('capDrop', capDropInput as any)"
          class="px-3 py-1.5 bg-amber-600/20 text-amber-400 rounded-lg text-sm hover:bg-amber-600/30 transition-colors"
        >Add</button>
      </div>
    </div>

    <!-- Restart policy -->
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Restart Policy</label>
      <select
        :value="modelValue.restartPolicy"
        @change="update('restartPolicy', ($event.target as HTMLSelectElement).value)"
        class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      >
        <option value="no">No</option>
        <option value="always">Always</option>
        <option value="unless-stopped">Unless Stopped</option>
        <option value="on-failure">On Failure</option>
      </select>
    </div>

    <!-- Hostname / User / Command -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Hostname</label>
        <input
          :value="modelValue.hostname ?? ''" placeholder="my-container"
          @input="update('hostname', ($event.target as HTMLInputElement).value || null)"
          class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
      </div>
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">User</label>
        <input
          :value="modelValue.user ?? ''" placeholder="1000:1000"
          @input="update('user', ($event.target as HTMLInputElement).value || null)"
          class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
      </div>
    </div>
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Command override</label>
      <input
        :value="modelValue.command ?? ''" placeholder="/bin/sh -c 'echo hello'"
        @input="update('command', ($event.target as HTMLInputElement).value || null)"
        class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
    </div>

    <!-- CPU / Memory -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">CPU Limit</label>
        <input
          type="number" min="0" max="64" step="0.1"
          :value="modelValue.cpuLimit ?? ''" placeholder="e.g. 0.5"
          @input="update('cpuLimit', ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null)"
          class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
      </div>
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Memory Limit</label>
        <input
          :value="modelValue.memoryLimit ?? ''" placeholder="e.g. 512m, 2g"
          @input="update('memoryLimit', ($event.target as HTMLInputElement).value || null)"
          class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
      </div>
    </div>

  </div>
</template>
