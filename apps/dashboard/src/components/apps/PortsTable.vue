<script setup lang="ts">
import { ref, watch } from 'vue'
import RowEditor from '../ui/RowEditor.vue'
import { trpc } from '../../lib/trpc'

export interface PortMapping {
  hostPort:      number
  containerPort: number
  protocol:      'tcp' | 'udp'
  domain?:       string
  tls?:          boolean
  publicPort?:   number
}

const props = defineProps<{ modelValue: PortMapping[]; appId?: string }>()
defineEmits<{ 'update:modelValue': [v: PortMapping[]] }>()

// Non-blocking "port already in use" warnings, keyed by row index.
const warnings = ref<Record<number, string>>({})
let timer: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.modelValue.map(p => `${p.hostPort}/${p.protocol}`).join(','),
  () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runChecks, 400)
  },
)

async function runChecks() {
  const next: Record<number, string> = {}
  await Promise.all(props.modelValue.map(async (p, i) => {
    if (!p.hostPort || p.hostPort < 1 || p.hostPort > 65535) return
    try {
      const r = await trpc.container.app.checkPort.query({
        port: p.hostPort, protocol: p.protocol, excludeAppId: props.appId,
      })
      if (r.inUse) next[i] = `Port ${p.hostPort} is already used by ${r.by}.`
    } catch { /* best-effort — ignore */ }
  }))
  warnings.value = next
}
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

    <template #extra="{ item, index, update }">
      <!-- Conflict warning (non-blocking) -->
      <p v-if="warnings[index]" class="text-xs text-[var(--c-warning)] pl-1">{{ warnings[index] }}</p>

      <!-- Optional access binding: where this port is reached publicly. -->
      <div class="flex items-center gap-2 flex-wrap pl-1">
        <span class="text-[11px] uppercase tracking-wide text-[var(--c-text-3)] w-14 shrink-0">Access</span>
        <input
          type="text" placeholder="domain (optional) e.g. app.example.com"
          :value="item.domain ?? ''"
          @input="update({ domain: ($event.target as HTMLInputElement).value || undefined })"
          class="flex-1 min-w-[12rem] bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1 text-xs text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
        <label class="inline-flex items-center gap-1 text-xs text-[var(--c-text-2)] cursor-pointer select-none">
          <input
            type="checkbox"
            :checked="!!item.tls"
            @change="update({ tls: ($event.target as HTMLInputElement).checked })"
          />
          HTTPS
        </label>
        <input
          type="number" placeholder="443" min="1" max="65535"
          :value="item.publicPort ?? ''"
          @input="update({ publicPort: ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : undefined })"
          class="w-20 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1 text-xs text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
        />
      </div>
    </template>
  </RowEditor>
</template>
