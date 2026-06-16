<script setup lang="ts">
export interface PortMapping {
  hostPort:      number
  containerPort: number
  protocol:      'tcp' | 'udp'
}

const props  = defineProps<{ modelValue: PortMapping[] }>()
const emit   = defineEmits<{ 'update:modelValue': [v: PortMapping[]] }>()

function add() {
  emit('update:modelValue', [...props.modelValue, { hostPort: 0, containerPort: 0, protocol: 'tcp' }])
}
function remove(i: number) {
  emit('update:modelValue', props.modelValue.filter((_, idx) => idx !== i))
}
function update(i: number, field: keyof PortMapping, val: string | number) {
  const copy = props.modelValue.map((p, idx) => idx === i ? { ...p, [field]: val } : p)
  emit('update:modelValue', copy)
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="modelValue.length === 0" class="text-sm text-[var(--c-text-3)] py-2">No port mappings.</div>
    <div
      v-for="(port, i) in modelValue" :key="i"
      class="flex items-center gap-2"
    >
      <input
        type="number" placeholder="Host" min="1" max="65535"
        :value="port.hostPort"
        @input="update(i, 'hostPort', +($event.target as HTMLInputElement).value)"
        class="w-24 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <span class="text-[var(--c-text-3)] text-sm">:</span>
      <input
        type="number" placeholder="Container" min="1" max="65535"
        :value="port.containerPort"
        @input="update(i, 'containerPort', +($event.target as HTMLInputElement).value)"
        class="w-24 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <select
        :value="port.protocol"
        @change="update(i, 'protocol', ($event.target as HTMLSelectElement).value)"
        class="bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      >
        <option value="tcp">TCP</option>
        <option value="udp">UDP</option>
      </select>
      <button @click="remove(i)" class="p-1.5 text-[var(--c-text-3)] hover:text-red-400 transition-colors">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <button
      @click="add"
      class="flex items-center gap-1.5 text-sm text-[var(--c-accent)] hover:opacity-80 transition-colors"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
      </svg>
      Add port
    </button>
  </div>
</template>
