<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { useNotifications } from '../lib/notifications'
import Modal from './ui/Modal.vue'
import LoadingSpinner from './ui/LoadingSpinner.vue'

const props = defineProps<{ path: string }>()
const emit  = defineEmits<{ (e: 'close'): void }>()

const { isAdmin } = useAuth()
const { track }   = useNotifications()

// ── state ─────────────────────────────────────────────────────────────────────
const loading = ref(true)
const saving  = ref(false)

interface PermBits { r: boolean; w: boolean; x: boolean }
const bits = ref<{ owner: PermBits; group: PermBits; other: PermBits }>({
  owner: { r: false, w: false, x: false },
  group: { r: false, w: false, x: false },
  other: { r: false, w: false, x: false },
})
const owner = ref('')
const group = ref('')
const fileType = ref('')
const fileSize = ref<number | null>(null)

// ── helpers ───────────────────────────────────────────────────────────────────
function parseModeStr(mode: string) {
  const n = parseInt(mode, 8)
  const p = (shift: number): PermBits => ({
    r: !!((n >> shift) & 4),
    w: !!((n >> shift) & 2),
    x: !!((n >> shift) & 1),
  })
  return { owner: p(6), group: p(3), other: p(0) }
}

function serializeMode(): string {
  const b = (g: PermBits) => (g.r ? 4 : 0) + (g.w ? 2 : 0) + (g.x ? 1 : 0)
  return `${b(bits.value.owner)}${b(bits.value.group)}${b(bits.value.other)}`
}

const modeDisplay = computed(() => {
  const sym = (g: PermBits) => `${g.r ? 'r' : '-'}${g.w ? 'w' : '-'}${g.x ? 'x' : '-'}`
  return sym(bits.value.owner) + sym(bits.value.group) + sym(bits.value.other)
})

// ── load ──────────────────────────────────────────────────────────────────────
async function load() {
  loading.value = true
  try {
    const s = await trpc.fs.stat.query({ path: props.path }) as any
    bits.value  = parseModeStr(s.mode)
    owner.value = s.owner
    group.value = s.group
    fileType.value = s.type
    fileSize.value = s.size
  } finally {
    loading.value = false
  }
}

watch(() => props.path, load, { immediate: true })

// ── save ──────────────────────────────────────────────────────────────────────
async function save() {
  saving.value = true
  try {
    const mode = serializeMode()
    await track(`chmod ${mode} ${props.path.split('/').pop()}`, async () => {
      await trpc.fs.chmod.mutate({ path: props.path, mode })
      if (isAdmin.value) {
        await trpc.fs.chown.mutate({ path: props.path, owner: owner.value, group: group.value })
      }
    })
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal panel-class="w-[420px]" @close="emit('close')">
    <template #header>
      <div>
        <div class="text-sm font-medium text-[var(--c-text-1)] truncate">{{ path.split('/').pop() }}</div>
        <div class="text-xs text-[var(--c-text-3)] font-mono mt-0.5">{{ path }}</div>
      </div>
    </template>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm p-6">
      <LoadingSpinner />
    </div>

    <template v-else>
      <div class="p-5 space-y-5">

            <!-- Mode display -->
            <div class="flex items-center gap-3">
              <span class="font-mono text-lg text-[var(--c-text-1)] tracking-widest">{{ modeDisplay }}</span>
              <span class="font-mono text-xs text-[var(--c-text-3)] bg-[var(--c-surface-deep)] px-2 py-0.5 rounded-sm">{{ serializeMode() }}</span>
            </div>

            <!-- Permission grid -->
            <table class="w-full text-sm">
              <thead>
                <tr class="text-xs text-[var(--c-text-3)] uppercase tracking-wider">
                  <th class="text-left font-medium pb-2 w-20"></th>
                  <th class="text-center font-medium pb-2 w-16">Read</th>
                  <th class="text-center font-medium pb-2 w-16">Write</th>
                  <th class="text-center font-medium pb-2 w-16">Execute</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--c-border)]">
                <tr v-for="(label, key) in { owner: 'Owner', group: 'Group', other: 'Other' }" :key="key">
                  <td class="py-2.5 text-[var(--c-text-3)] text-xs">{{ label }}</td>
                  <td v-for="bit in (['r', 'w', 'x'] as const)" :key="bit" class="py-2.5 text-center">
                    <input
                      type="checkbox"
                      v-model="(bits[key as keyof typeof bits] as any)[bit]"
                      :disabled="!isAdmin"
                      class="w-3.5 h-3.5 rounded accent-accent cursor-pointer disabled:cursor-default"
                    />
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- Owner / Group (admin only) -->
            <div v-if="isAdmin" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-[var(--c-text-3)] mb-1">Owner</label>
                <input
                  v-model="owner"
                  class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-3)]
                         font-mono focus:outline-none focus:border-[var(--c-accent)] transition-colors"
                />
              </div>
              <div>
                <label class="block text-xs text-[var(--c-text-3)] mb-1">Group</label>
                <input
                  v-model="group"
                  class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-3)]
                         font-mono focus:outline-none focus:border-[var(--c-accent)] transition-colors"
                />
              </div>
            </div>
            <div v-else class="flex gap-4 text-sm">
              <div><span class="text-[var(--c-text-3)] text-xs mr-1">Owner</span><span class="font-mono text-[var(--c-text-2)]">{{ owner }}</span></div>
              <div><span class="text-[var(--c-text-3)] text-xs mr-1">Group</span><span class="font-mono text-[var(--c-text-2)]">{{ group }}</span></div>
            </div>

      </div>
    </template>

    <template v-if="!loading && isAdmin" #footer>
      <button @click="emit('close')" class="btn btn-ghost btn-sm">Cancel</button>
      <button
        @click="save"
        :disabled="saving"
        class="btn btn-primary btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {{ saving ? 'Applying…' : 'Apply' }}
      </button>
    </template>
  </Modal>
</template>
