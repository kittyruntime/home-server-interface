<script setup lang="ts">
import RowEditor from '../ui/RowEditor.vue'

export interface PortMapping {
  hostPort:      number
  containerPort: number
  protocol:      'tcp' | 'udp'
}

defineProps<{ modelValue: PortMapping[] }>()
defineEmits<{ 'update:modelValue': [v: PortMapping[]] }>()
</script>

<template>
  <RowEditor
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    empty-text="No port mappings."
    add-label="Add port"
    :new-item="(): PortMapping => ({ hostPort: 0, containerPort: 0, protocol: 'tcp' })"
  >
    <template #row="{ item, update }">
      <input
        type="number" placeholder="Host" min="1" max="65535"
        :value="item.hostPort"
        @input="update({ hostPort: +($event.target as HTMLInputElement).value })"
        class="w-24 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <span class="text-[var(--c-text-3)] text-sm">:</span>
      <input
        type="number" placeholder="Container" min="1" max="65535"
        :value="item.containerPort"
        @input="update({ containerPort: +($event.target as HTMLInputElement).value })"
        class="w-24 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      />
      <select
        :value="item.protocol"
        @change="update({ protocol: ($event.target as HTMLSelectElement).value as 'tcp' | 'udp' })"
        class="bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
      >
        <option value="tcp">TCP</option>
        <option value="udp">UDP</option>
      </select>
    </template>
  </RowEditor>
</template>
