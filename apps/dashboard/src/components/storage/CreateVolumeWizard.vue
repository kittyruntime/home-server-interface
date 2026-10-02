<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { applyPlanned } from '../../lib/plan'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { isFreeDisk } from './device-state'
import { possibleLevels, usableBytes, tolerance, proposeName, mountFor, levelsHint, type Level } from './volume-wizard'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'

// Create volume (#40): free disks to a mounted, owned, optionally shared
// volume, through one reviewed plan. The step on the left, the volume as it
// will be on the right (mockup C).

const props = defineProps<{ disks?: string[] }>()
const emit = defineEmits<{
  navigate: [target: StorageSection | StorageLocation]
  dirty: [dirty: boolean]
}>()

const { isAdmin } = useAuth()
const { devices, lvmVGs, loaded } = useStorageData()

const STEPS = ['Disks', 'Redundancy', 'Layout', 'Filesystem', 'Mount', 'Access', 'Review'] as const
const step = ref(0)

const freeDisks = computed(() => devices.value.filter(d => isFreeDisk(d)))
const labels = ref<Record<string, string>>({})
const mountPoints = ref<string[]>([])
const users = ref<Array<{ id: string; username: string; displayName: string | null }>>([])

const s = reactive({
  disks: new Set<string>(props.disks ?? []),
  level: 'raid1' as Level,
  name: 'data',
  vg: 'data',
  lv: 'data',
  advanced: false,
  lvPercent: 100,
  label: 'data',
  mountpoint: '/srv/data',
  mountEdited: false,
  access: 'shared' as 'shared' | 'user' | 'keep',
  ownerUserId: '',
  createPlace: true,
  placeName: 'data',
  share: false,
  smbName: 'data',
})

onMounted(async () => {
  trpc.storage.diskLabels.list.query()
    .then(ls => { labels.value = Object.fromEntries(ls.map(l => [l.serial, l.label])) }).catch(() => {})
  trpc.storage.volumes.overview.query()
    .then(o => { mountPoints.value = o.volumes.map(v => v.mountPoint ?? v.expectedMountPoint ?? '').filter(Boolean) }).catch(() => {})
    .finally(() => setName(proposeName(lvmVGs.value.map(v => v.name), mountPoints.value)))
  if (isAdmin.value) trpc.user.list.query().then(u => { users.value = u as typeof users.value }).catch(() => {})
})

// Keep only disks that are still free once the list is known.
watch([loaded, freeDisks], () => {
  if (!loaded.value) return
  const ok = new Set(freeDisks.value.map(d => d.name))
  const gone = [...s.disks].filter(n => !ok.has(n))
  if (!gone.length) return
  s.disks = new Set([...s.disks].filter(n => ok.has(n)))
  notice.value = `${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer free and left the selection.`
})
// Something changed the choices behind the admin's back: say so.
const notice = ref('')

function setName(n: string) {
  s.name = n; s.vg = n; s.lv = n; s.label = n.slice(0, 16)
  if (!s.mountEdited) s.mountpoint = mountFor(n)
  s.placeName = n; s.smbName = n
}

function toggleDisk(name: string) {
  notice.value = ''
  const next = new Set(s.disks)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  s.disks = next
}

const chosen = computed(() => freeDisks.value.filter(d => s.disks.has(d.name)))
const levels = computed(() => possibleLevels(chosen.value.length))
// Until the admin picks a level, follow the most redundant one possible.
const levelPicked = ref(false)
const usable = computed(() => Math.floor(usableBytes(s.level, chosen.value.map(d => d.size)) * s.lvPercent / 100))
const tolerates = computed(() => tolerance(s.level, chosen.value.length))

const LEVEL_TEXT: Record<Level, { title: string; text: string }> = {
  raid1:  { title: 'Mirror', text: 'Every disk holds a full copy.' },
  raid5:  { title: 'RAID 5', text: 'Data and parity spread over the disks.' },
  raid6:  { title: 'RAID 6', text: 'Data and double parity spread over the disks.' },
  raid10: { title: 'RAID 10', text: 'Mirrored pairs, striped together.' },
  none:   { title: 'No redundancy', text: 'All the space is usable, but one failing disk loses the whole volume.' },
}
watch(levels, ls => {
  if (levelPicked.value && !ls.includes(s.level)) {
    notice.value = `${LEVEL_TEXT[s.level].title} needs more disks: the redundancy is now ${LEVEL_TEXT[ls[0] ?? 'none'].title}.`
    levelPicked.value = false
  }
  if (!levelPicked.value) s.level = ls[0] ?? 'none'
}, { immediate: true })
function levelLine(l: Level): string {
  const t = tolerance(l, chosen.value.length)
  const use = fmtBytes(usableBytes(l, chosen.value.map(d => d.size)))
  return t ? `Survives ${t} failed ${t === 1 ? 'disk' : 'disks'}. Usable: ${use}.` : `Usable: ${use}.`
}

const SYSTEM = ['/', '/boot', '/boot/efi', '/usr', '/var', '/home', '/tmp', '/etc', '/proc', '/sys', '/dev', '/efi']
const mountError = computed(() => {
  const mp = s.mountpoint.trim()
  if (!mp.startsWith('/') || mp.length < 2) return 'An absolute folder, for example /srv/data'
  if (/[\s#]/.test(mp) || mp.includes('..')) return 'No spaces, # or .. in the folder'
  if (SYSTEM.includes(mp.replace(/\/$/, ''))) return 'This is a system folder'
  if (mountPoints.value.includes(mp)) return 'Another volume uses this folder'
  return ''
})
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/
const canNext = computed(() => {
  switch (step.value) {
    case 0: return chosen.value.length > 0
    case 1: return levels.value.includes(s.level)
    case 2: return NAME.test(s.vg) && NAME.test(s.lv) && !lvmVGs.value.some(v => v.name === s.vg) && s.lvPercent >= 1 && s.lvPercent <= 100
    case 3: return /^[A-Za-z0-9_.-]{1,16}$/.test(s.label)
    case 4: return !mountError.value
    case 5: return (s.access !== 'user' || !!s.ownerUserId) && (!s.createPlace || !isAdmin.value || !!s.placeName.trim())
    default: return true
  }
})

// Anything chosen makes leaving ask first, until the volume is created.
const done = ref(false)
watch(() => [s.disks.size, step.value], () => emit('dirty', !done.value && (s.disks.size > 0 || step.value > 0)), { immediate: true })
onBeforeUnmount(() => emit('dirty', false))

function input() {
  const place = isAdmin.value && s.createPlace ? { name: s.placeName.trim() } : undefined
  return {
    volume: {
      disks: chosen.value.map(d => d.name), redundancy: s.level, vg: s.vg, lv: s.lv, lvPercent: s.lvPercent,
      label: s.label, mountpoint: s.mountpoint.trim(), access: s.access,
      ...(s.access === 'user' ? { ownerUserId: s.ownerUserId } : {}),
    },
    ...(place ? { place } : {}),
    ...(place && s.share ? { share: { smbName: s.smbName || undefined } } : {}),
  }
}

const error = ref('')
async function create() {
  error.value = ''
  try {
    await applyPlanned('volume.create', input(), {
      domain: 'volume', title: `Create the volume ${s.name}`, actionLabel: 'Create volume', danger: true,
    })
    done.value = true
    emit('dirty', false)
    const o = await trpc.storage.volumes.overview.query()
    const v = o.volumes.find(x => x.mountPoint === s.mountpoint.trim())
    emit('navigate', v ? { kind: 'volume', id: v.id } : 'volumes')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    // A run that failed part way may have erased the disks already: the
    // wizard's choices no longer describe the host, so it is not run again.
    if (error.value) { done.value = true; emit('dirty', false) }
  }
}

function diskLabel(d: BlockDev): string {
  return (d.serial && labels.value[d.serial]) || ''
}
</script>

<template>
  <div class="max-w-4xl">
    <div class="flex items-center justify-between gap-3 mb-2">
      <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Create volume</h2>
      <span class="text-xs text-[var(--c-text-3)]">Step {{ step + 1 }} of {{ STEPS.length }} · {{ STEPS[step] }}</span>
    </div>
    <div class="h-0.5 rounded-full bg-[var(--c-hover)] mb-5" role="progressbar" :aria-valuenow="step + 1" aria-valuemin="1" :aria-valuemax="STEPS.length">
      <div class="h-full rounded-full bg-[var(--c-accent)] transition-[width]" :style="{ width: `${((step + 1) / STEPS.length) * 100}%` }" />
    </div>

    <!-- Narrow: the volume so far as one line -->
    <p class="@3xl/content:hidden mb-4 text-xs text-[var(--c-text-3)]">
      <span class="font-figure font-bold text-sm text-[var(--c-text-1)]">{{ fmtBytes(usable) }}</span> usable ·
      {{ LEVEL_TEXT[s.level].title }}<template v-if="chosen.length"> · {{ chosen.map(d => d.name).join(', ') }}</template> ·
      <span class="font-mono">{{ s.mountpoint }}</span>
    </p>

    <p v-if="notice" role="status" class="mb-4 status-text text-warning"><span class="status-tag">[WARN]</span> {{ notice }}</p>
    <div class="grid @3xl/content:grid-cols-[1fr_15rem] gap-6">
      <section class="min-w-0">
        <!-- 1. Disks -->
        <template v-if="step === 0">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-3">Which disks?</h3>
          <p v-if="!freeDisks.length" class="text-sm text-[var(--c-text-3)]">No free disk. Connect a disk, or free one in Disks, to create a volume.</p>
          <ul v-else class="space-y-1.5">
            <li v-for="d in freeDisks" :key="d.name">
              <label class="flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors"
                :class="s.disks.has(d.name) ? 'border-[var(--c-text-1)]' : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]'">
                <input type="checkbox" class="accent-accent" :checked="s.disks.has(d.name)" @change="toggleDisk(d.name)" />
                <span class="font-mono text-sm text-[var(--c-text-1)] w-20 shrink-0">/dev/{{ d.name }}</span>
                <span class="flex-1 min-w-0 text-xs text-[var(--c-text-2)] truncate">
                  {{ d.model || 'Unknown model' }}<span v-if="d.serial" class="font-mono"> · {{ d.serial }}</span><span v-if="diskLabel(d)"> · {{ diskLabel(d) }}</span>
                </span>
                <span class="font-mono tabular-nums text-xs text-[var(--c-text-2)] shrink-0">{{ fmtBytes(d.size) }}</span>
              </label>
            </li>
          </ul>
          <p class="mt-3 text-xs text-warning">Everything on the chosen disks will be erased.</p>
        </template>

        <!-- 2. Redundancy -->
        <template v-else-if="step === 1">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-3">How should the data survive a disk failure?</h3>
          <div role="radiogroup" class="space-y-1.5">
            <label v-for="l in levels" :key="l" class="flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors"
              :class="s.level === l ? 'border-[var(--c-text-1)]' : 'border-[var(--c-border)] hover:border-[var(--c-border-strong)]'">
              <input type="radio" class="mt-1 accent-accent" name="level" :value="l" v-model="s.level" @change="levelPicked = true" />
              <span>
                <span class="block text-sm font-medium" :class="l === 'none' ? 'text-danger' : 'text-[var(--c-text-1)]'">{{ LEVEL_TEXT[l].title }}</span>
                <span class="block text-xs text-[var(--c-text-3)]">{{ LEVEL_TEXT[l].text }} {{ levelLine(l) }}</span>
              </span>
            </label>
          </div>
          <p v-if="levelsHint(chosen.length)" class="mt-3 text-xs text-[var(--c-text-3)]">{{ levelsHint(chosen.length) }}</p>
        </template>

        <!-- 3. Layout -->
        <template v-else-if="step === 2">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-1">Layout</h3>
          <p class="text-xs text-[var(--c-text-3)] mb-3">The volume is a logical volume in an LVM volume group, so it can be expanded later without reformatting.</p>
          <div class="grid grid-cols-2 gap-3 max-w-md">
            <label class="text-xs text-[var(--c-text-3)]">Volume group
              <input v-model.trim="s.vg" class="ui-input mt-1 font-mono" maxlength="31" />
            </label>
            <label class="text-xs text-[var(--c-text-3)]">Logical volume
              <input v-model.trim="s.lv" class="ui-input mt-1 font-mono" maxlength="31" />
            </label>
          </div>
          <p v-if="lvmVGs.some(v => v.name === s.vg)" class="mt-2 status-text text-danger"><span class="status-tag">[ERR]</span> A volume group named {{ s.vg }} already exists.</p>
          <button class="mt-4 text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)]" :aria-expanded="s.advanced" @click="s.advanced = !s.advanced">
            {{ s.advanced ? 'Hide advanced' : 'Advanced' }}
          </button>
          <label v-if="s.advanced" class="mt-2 block max-w-xs text-xs text-[var(--c-text-3)]">Use {{ s.lvPercent }}% of the volume group
            <input type="range" min="10" max="100" step="5" v-model.number="s.lvPercent" class="w-full accent-accent" />
            <span class="block mt-1">The rest stays free in the volume group, for another volume or for snapshots.</span>
          </label>
        </template>

        <!-- 4. Filesystem -->
        <template v-else-if="step === 3">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-1">Filesystem</h3>
          <p class="text-xs text-[var(--c-text-3)] mb-3">ext4, the standard Linux filesystem.</p>
          <label class="block max-w-xs text-xs text-[var(--c-text-3)]">Label
            <input v-model.trim="s.label" class="ui-input mt-1 font-mono" maxlength="16" />
          </label>
        </template>

        <!-- 5. Mount -->
        <template v-else-if="step === 4">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-1">Where should it appear?</h3>
          <p class="text-xs text-[var(--c-text-3)] mb-3">The folder the volume is mounted on, at every boot.</p>
          <label class="block max-w-md text-xs text-[var(--c-text-3)]">Folder
            <input v-model.trim="s.mountpoint" class="ui-input mt-1 font-mono" @input="s.mountEdited = true" />
          </label>
          <p v-if="mountError" class="mt-2 status-text text-danger"><span class="status-tag">[ERR]</span> {{ mountError }}</p>
        </template>

        <!-- 6. Access -->
        <template v-else-if="step === 5">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-3">Who can use it?</h3>
          <div role="radiogroup" class="space-y-1.5 max-w-lg">
            <label class="flex items-start gap-3 cursor-pointer"><input type="radio" class="mt-1 accent-accent" value="shared" v-model="s.access" />
              <span class="text-sm text-[var(--c-text-1)]">You and the shared group<span class="block text-xs text-[var(--c-text-3)]">Writable by you and by the users given write access through Places.</span></span></label>
            <label v-if="isAdmin" class="flex items-start gap-3 cursor-pointer"><input type="radio" class="mt-1 accent-accent" value="user" v-model="s.access" />
              <span class="text-sm text-[var(--c-text-1)]">Another user<span class="block text-xs text-[var(--c-text-3)]">Owned by the user you choose, with the shared group.</span></span></label>
            <label class="flex items-start gap-3 cursor-pointer"><input type="radio" class="mt-1 accent-accent" value="keep" v-model="s.access" />
              <span class="text-sm text-[var(--c-text-1)]">Only root<span class="block text-xs text-[var(--c-text-3)]">Left as root:root, for system use.</span></span></label>
          </div>
          <select v-if="s.access === 'user'" v-model="s.ownerUserId" class="ui-input mt-3 max-w-xs" aria-label="Owner">
            <option value="" disabled>Choose a user</option>
            <option v-for="u in users" :key="u.id" :value="u.id">{{ u.displayName || u.username }} ({{ u.username }})</option>
          </select>

          <div v-if="isAdmin" class="mt-5 space-y-3 max-w-lg">
            <label class="flex items-start gap-3 cursor-pointer"><input type="checkbox" class="mt-1 accent-accent" v-model="s.createPlace" />
              <span class="text-sm text-[var(--c-text-1)]">Create a Place<span class="block text-xs text-[var(--c-text-3)]">So users see it in Files. You choose who can read or write in Places.</span></span></label>
            <input v-if="s.createPlace" v-model="s.placeName" class="ui-input max-w-xs" aria-label="Place name" maxlength="64" />
            <label v-if="s.createPlace" class="flex items-start gap-3 cursor-pointer"><input type="checkbox" class="mt-1 accent-accent" v-model="s.share" />
              <span class="text-sm text-[var(--c-text-1)]">Share it over SMB<span class="block text-xs text-[var(--c-text-3)]">Reachable from other computers on the network.</span></span></label>
            <input v-if="s.createPlace && s.share" v-model.trim="s.smbName" class="ui-input max-w-xs font-mono" aria-label="Share name" maxlength="32" />
          </div>
        </template>

        <!-- 7. Review -->
        <template v-else>
          <h3 class="text-sm font-semibold text-[var(--c-text-1)] mb-3">Review</h3>
          <dl class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] divide-y divide-[var(--c-border)] text-sm max-w-lg">
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-[var(--c-text-3)]">Disks</dt><dd class="font-mono text-xs self-center">{{ chosen.map(d => `/dev/${d.name}`).join(', ') }}</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-[var(--c-text-3)]">Redundancy</dt><dd>{{ LEVEL_TEXT[s.level].title }}</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-[var(--c-text-3)]">LVM</dt><dd class="font-mono text-xs self-center">{{ s.vg }}/{{ s.lv }} · {{ s.lvPercent }}%</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-[var(--c-text-3)]">Filesystem</dt><dd class="font-mono text-xs self-center">ext4 · {{ s.label }}</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-[var(--c-text-3)]">Folder</dt><dd class="font-mono text-xs self-center">{{ s.mountpoint }}</dd></div>
            <div v-if="isAdmin && s.createPlace" class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-[var(--c-text-3)]">Place</dt><dd>{{ s.placeName }}<template v-if="s.share"> · shared as <span class="font-mono text-xs">{{ s.smbName }}</span></template></dd></div>
          </dl>
          <p class="mt-3 text-xs text-[var(--c-text-3)]">Next, HSI shows every command and file change, and names the disks it erases, before anything runs.</p>
          <p v-if="error" role="alert" class="mt-3 status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>
        </template>
      </section>

      <!-- The volume as it will be -->
      <aside class="hidden @3xl/content:block self-start rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] p-4 space-y-2">
        <p class="eyebrow">Your volume</p>
        <p><span class="font-figure font-bold text-2xl tabular-nums text-[var(--c-text-1)]">{{ fmtBytes(usable) }}</span> <span class="text-xs text-[var(--c-text-3)]">usable</span></p>
        <p class="text-xs" :class="s.level === 'none' ? 'text-danger' : 'text-[var(--c-text-2)]'">
          {{ LEVEL_TEXT[s.level].title }}<template v-if="tolerates"> · survives {{ tolerates }} failed {{ tolerates === 1 ? 'disk' : 'disks' }}</template>
        </p>
        <p class="text-xs text-[var(--c-text-3)]">{{ chosen.length ? chosen.map(d => d.name).join(', ') : 'No disk chosen' }}</p>
        <p class="font-mono text-xs text-[var(--c-text-2)]">{{ s.mountpoint }}</p>
        <p v-if="isAdmin && s.createPlace" class="text-xs text-[var(--c-text-3)]">Place "{{ s.placeName }}"<template v-if="s.share"> · SMB share</template></p>
      </aside>
    </div>

    <div class="mt-6 flex items-center justify-between gap-3 border-t border-[var(--c-border)] pt-4">
      <button v-if="step > 0" class="btn btn-ghost btn-sm" @click="step--">Back</button>
      <button v-else class="btn btn-ghost btn-sm" @click="emit('navigate', 'volumes')">Cancel</button>
      <button v-if="step < STEPS.length - 1" class="btn btn-primary btn-sm" :disabled="!canNext" @click="step++">Next: {{ STEPS[step + 1] }}</button>
      <button v-else-if="done" class="btn btn-primary btn-sm" @click="emit('navigate', 'volumes')">Go to Volumes</button>
      <button v-else class="btn btn-danger btn-sm" :disabled="!chosen.length" @click="create">Create volume</button>
    </div>
  </div>
</template>
