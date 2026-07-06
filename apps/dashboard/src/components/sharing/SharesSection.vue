<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'
import { useConfirm } from '../../lib/confirm'

const { confirm } = useConfirm()

type ShareRow = {
  id: string
  placeId: string
  placeName: string
  placePath: string
  enabled: boolean
  readOnly: boolean
  guestOk: boolean
  smbName: string | null
  effectiveName: string
  userCount: number
  excludedUsernames: string[]
}

type PlaceRow = { id: string; name: string; path: string }

const prereq  = ref<{ smbdInstalled: boolean } | null>(null)
const shares  = ref<ShareRow[]>([])
const places  = ref<PlaceRow[]>([])
const loading = ref(true)
const error   = ref('')

// null = closed; { id: null } = create; { id: string } = edit
const editor = ref<{
  id: string | null
  placeId: string
  smbName: string
  readOnly: boolean
  guestOk: boolean
} | null>(null)
const saving      = ref(false)
const editorError = ref('')
const deleting    = ref<string | null>(null)

const availablePlaces = computed(() => {
  const sharedIds = new Set(shares.value.map(s => s.placeId))
  return places.value.filter(p => !sharedIds.has(p.id))
})

async function refresh() {
  error.value = ''
  try {
    const [p, s, pl] = await Promise.all([
      trpc.sharing.checkPrereqs.query(),
      trpc.sharing.list.query(),
      trpc.place.list.query(),
    ])
    prereq.value = p
    shares.value = s
    places.value = pl as PlaceRow[]
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load shares'
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

function openCreate() {
  editorError.value = ''
  editor.value = {
    id: null,
    placeId: availablePlaces.value[0]?.id ?? '',
    smbName: '',
    readOnly: false,
    guestOk: false,
  }
}

function openEdit(s: ShareRow) {
  editorError.value = ''
  editor.value = {
    id: s.id,
    placeId: s.placeId,
    smbName: s.smbName ?? '',
    readOnly: s.readOnly,
    guestOk: s.guestOk,
  }
}

async function save() {
  if (!editor.value) return
  saving.value = true
  editorError.value = ''
  try {
    if (editor.value.id === null) {
      await trpc.sharing.create.mutate({
        placeId: editor.value.placeId,
        smbName: editor.value.smbName.trim() || undefined,
        readOnly: editor.value.readOnly,
        guestOk: editor.value.guestOk,
      })
    } else {
      await trpc.sharing.update.mutate({
        id: editor.value.id,
        smbName: editor.value.smbName.trim() || null,
        readOnly: editor.value.readOnly,
        guestOk: editor.value.guestOk,
      })
    }
    editor.value = null
    await refresh()
  } catch (e: unknown) {
    editorError.value = (e as { message?: string })?.message ?? 'Failed to save share'
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(s: ShareRow) {
  error.value = ''
  try {
    await trpc.sharing.update.mutate({ id: s.id, enabled: !s.enabled })
    await refresh()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to update share'
  }
}

async function removeShare(s: ShareRow) {
  if (!await confirm(`Stop sharing "${s.effectiveName}"? Clients will lose access.`, { danger: true, confirmLabel: 'Stop sharing' })) return
  deleting.value = s.id
  error.value = ''
  try {
    await trpc.sharing.remove.mutate({ id: s.id })
    await refresh()
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to delete share'
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <p class="eyebrow mb-1">Network sharing</p>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">SMB shares</h2>
      </div>
      <button
        v-if="prereq?.smbdInstalled && availablePlaces.length > 0"
        class="btn btn-primary btn-sm"
        @click="openCreate"
      >
        New share
      </button>
    </div>

    <p v-if="error" class="status-text text-[var(--c-danger)] mb-4">[ERR] {{ error }}</p>

    <div v-if="loading" class="text-sm text-[var(--c-text-3)]">Loading…</div>

    <!-- Samba missing: guide, never a cryptic error -->
    <div v-else-if="prereq && !prereq.smbdInstalled" class="panel-card bg-[var(--c-surface)] p-6">
      <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-2">Samba is not installed</h3>
      <p class="text-sm text-[var(--c-text-2)] mb-4">
        SMB sharing needs the Samba server on the host. Install it, then come back here — nothing else to configure.
      </p>
      <code class="inline-block px-3 py-2 rounded-lg bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)] text-sm font-mono text-[var(--c-text-1)]">
        sudo apt install samba
      </code>
      <div class="mt-4">
        <button class="btn btn-outline btn-sm" @click="refresh">Check again</button>
      </div>
    </div>

    <div v-else-if="shares.length === 0" class="panel-card bg-[var(--c-surface)] p-6 text-sm text-[var(--c-text-3)]">
      No shares yet. Share an existing place to make it reachable from Windows Explorer, Finder, or any SMB client.
    </div>

    <div v-else class="space-y-3">
      <div v-for="s in shares" :key="s.id" class="panel-card bg-[var(--c-surface)] p-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-[var(--c-text-1)]">{{ s.effectiveName }}</span>
              <span :class="['badge', s.enabled ? 'badge-accent' : 'badge-muted']">
                {{ s.enabled ? 'Active' : 'Disabled' }}
              </span>
              <span v-if="s.readOnly" class="badge badge-muted">Read-only</span>
              <span v-if="s.guestOk" class="badge badge-muted">Guest</span>
            </div>
            <p class="text-xs text-[var(--c-text-3)] mt-1">
              {{ s.placeName }} · <span class="font-mono">{{ s.placePath }}</span> · {{ s.userCount }} user{{ s.userCount === 1 ? '' : 's' }}
            </p>
            <p v-if="s.excludedUsernames.length > 0" class="status-text text-[var(--c-warning)] mt-2">
              [WARN] No Linux account for {{ s.excludedUsernames.join(', ') }} — excluded from this share
            </p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button class="btn btn-ghost btn-xs" @click="toggleEnabled(s)">
              {{ s.enabled ? 'Disable' : 'Enable' }}
            </button>
            <button class="btn btn-ghost btn-xs" @click="openEdit(s)">Edit</button>
            <button class="btn btn-danger btn-xs" :disabled="deleting === s.id" @click="removeShare(s)">
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create / edit modal -->
    <Modal v-if="editor" panel-class="w-full max-w-sm" @close="editor = null">
      <template #header>
        <h3 class="text-sm font-semibold text-[var(--c-text-1)]">
          {{ editor.id === null ? 'New share' : 'Edit share' }}
        </h3>
      </template>

      <div class="p-6 space-y-4">
        <div v-if="editor.id === null">
          <p class="eyebrow mb-2">Place</p>
          <select v-model="editor.placeId" class="ui-input w-full">
            <option v-for="p in availablePlaces" :key="p.id" :value="p.id">
              {{ p.name }} — {{ p.path }}
            </option>
          </select>
        </div>

        <div>
          <p class="eyebrow mb-2">Share name</p>
          <input
            v-model="editor.smbName"
            type="text"
            placeholder="Defaults to the place name"
            class="ui-input w-full font-mono"
          />
          <p class="text-xs text-[var(--c-text-3)] mt-1">Letters, digits, dots, dashes, underscores. Max 32 characters.</p>
        </div>

        <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
          <input v-model="editor.readOnly" type="checkbox" />
          Read-only (ignore write permissions)
        </label>
        <label class="flex items-center gap-2 text-sm text-[var(--c-text-2)] cursor-pointer">
          <input v-model="editor.guestOk" type="checkbox" />
          Allow guest access (no authentication)
        </label>

        <p v-if="editorError" class="status-text text-[var(--c-danger)]">[ERR] {{ editorError }}</p>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-sm" @click="editor = null">Cancel</button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="saving || (editor.id === null && !editor.placeId)"
            @click="save"
          >
            {{ saving ? 'Saving…' : editor.id === null ? 'Create share' : 'Save' }}
          </button>
        </div>
      </template>
    </Modal>
  </div>
</template>
