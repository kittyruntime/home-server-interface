<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import LoadingState from './ui/LoadingState.vue'
import { ref, watch, computed } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { useNotifications } from '../lib/notifications'
import Modal from './ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

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
  <Modal panel-class="w-full max-w-[420px]" @close="emit('close')">
    <template #header>
      <div>
        <div class="text-sm font-medium text-foreground truncate">{{ path.split('/').pop() }}</div>
        <div class="text-xs text-muted-foreground font-mono mt-0.5">{{ path }}</div>
      </div>
    </template>

    <!-- Loading -->
    <LoadingState v-if="loading" variant="compact" />

    <template v-else>
      <div class="p-5 space-y-5">

            <!-- Mode display -->
            <div class="flex items-center gap-3">
              <span class="font-figure text-lg text-foreground tracking-widest">{{ modeDisplay }}</span>
              <span class="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-sm">{{ serializeMode() }}</span>
            </div>

            <!-- Permission grid -->
            <Table class="w-full text-sm">
              <TableHeader>
                <TableRow class="text-xs text-muted-foreground uppercase tracking-caps">
                  <TableHead class="text-left font-medium pb-2 w-20"></TableHead>
                  <TableHead class="text-center font-medium pb-2 w-16">{{ t('ui.settings.FilePermissionsDialog.read') }}</TableHead>
                  <TableHead class="text-center font-medium pb-2 w-16">{{ t('ui.settings.FilePermissionsDialog.write') }}</TableHead>
                  <TableHead class="text-center font-medium pb-2 w-16">{{ t('ui.settings.FilePermissionsDialog.execute') }}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody class="divide-y divide-border">
                <TableRow v-for="(label, key) in { owner: 'Owner', group: 'Group', other: 'Other' }" :key="key">
                  <TableCell class="py-2.5 text-muted-foreground text-xs">{{ label }}</TableCell>
                  <TableCell v-for="bit in (['r', 'w', 'x'] as const)" :key="bit" class="py-2.5 text-center">
                    <Checkbox v-model="(bits[key as keyof typeof bits] as any)[bit]" :disabled="!isAdmin" />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <!-- Owner / Group (admin only) -->
            <div v-if="isAdmin" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-muted-foreground mb-1">{{ t('ui.settings.FilePermissionsDialog.owner') }}</label>
                <Input
                  v-model="owner"
                  class="w-full px-3 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label class="block text-xs text-muted-foreground mb-1">{{ t('ui.settings.FilePermissionsDialog.group') }}</label>
                <Input
                  v-model="group"
                  class="w-full px-3 py-1.5 text-sm font-mono"
                />
              </div>
            </div>
            <div v-else class="flex gap-4 text-sm">
              <div><span class="text-muted-foreground text-xs mr-1">{{ t('ui.settings.FilePermissionsDialog.owner') }}</span><span class="font-mono text-foreground/80">{{ owner }}</span></div>
              <div><span class="text-muted-foreground text-xs mr-1">{{ t('ui.settings.FilePermissionsDialog.group') }}</span><span class="font-mono text-foreground/80">{{ group }}</span></div>
            </div>

      </div>
    </template>

    <template v-if="!loading && isAdmin" #footer>
      <Button variant="ghost" size="sm" @click="emit('close')">{{ t('ui.settings.FilePermissionsDialog.cancel') }}</Button>
      <Button size="sm"
        @click="save"
        :disabled="saving"
        class="disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {{ saving ? 'Applying…' : 'Apply' }}
      </Button>
    </template>
  </Modal>
</template>
