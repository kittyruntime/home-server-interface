<script setup lang="ts">
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { applyPlanned } from '../../lib/plan'
import { useStorageData, fmtBytes, type BlockDev } from './store'
import { isFreeDisk } from './device-state'
import { possibleLevels, usableBytes, tolerance, proposeName, mountFor, levelsHint, type Level } from './volume-wizard'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

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
      <h2 class="text-lg font-semibold text-foreground">Create volume</h2>
      <span class="text-xs text-muted-foreground">Step {{ step + 1 }} of {{ STEPS.length }} · {{ STEPS[step] }}</span>
    </div>
    <Progress class="h-0.5 rounded-full bg-accent mb-5" :model-value="((step + 1) / STEPS.length) * 100" indicator-class="rounded-full bg-primary transition-[width]" />

    <!-- Narrow: the volume so far as one line -->
    <p class="@3xl/content:hidden mb-4 text-xs text-muted-foreground">
      <span class="font-figure font-bold text-sm text-foreground">{{ fmtBytes(usable) }}</span> usable ·
      {{ LEVEL_TEXT[s.level].title }}<template v-if="chosen.length"> · {{ chosen.map(d => d.name).join(', ') }}</template> ·
      <span class="font-mono">{{ s.mountpoint }}</span>
    </p>

    <p v-if="notice" role="status" class="mb-4 status-text text-warning"><span class="status-tag">[WARN]</span> {{ notice }}</p>
    <div class="grid @3xl/content:grid-cols-[1fr_15rem] gap-6">
      <section class="min-w-0">
        <!-- 1. Disks -->
        <template v-if="step === 0">
          <h3 class="text-sm font-semibold text-foreground mb-3">Which disks?</h3>
          <p v-if="!freeDisks.length" class="text-sm text-muted-foreground">No free disk. Connect a disk, or free one in Disks, to create a volume.</p>
          <ul v-else class="space-y-1.5">
            <li v-for="d in freeDisks" :key="d.name">
              <label class="flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors"
                :class="s.disks.has(d.name) ? 'border-foreground' : 'border-border hover:border-input'">
                <Checkbox :model-value="s.disks.has(d.name)" @update:model-value="toggleDisk(d.name)" />
                <span class="font-mono text-sm text-foreground w-20 shrink-0">/dev/{{ d.name }}</span>
                <span class="flex-1 min-w-0 text-xs text-foreground/80 truncate">
                  {{ d.model || 'Unknown model' }}<span v-if="d.serial" class="font-mono"> · {{ d.serial }}</span><span v-if="diskLabel(d)"> · {{ diskLabel(d) }}</span>
                </span>
                <span class="font-mono tabular-nums text-xs text-foreground/80 shrink-0">{{ fmtBytes(d.size) }}</span>
              </label>
            </li>
          </ul>
          <p class="mt-3 text-xs text-warning">Everything on the chosen disks will be erased.</p>
        </template>

        <!-- 2. Redundancy -->
        <template v-else-if="step === 1">
          <h3 class="text-sm font-semibold text-foreground mb-3">How should the data survive a disk failure?</h3>
          <RadioGroup v-model="s.level" class="gap-1.5" @update:model-value="levelPicked = true">
            <label v-for="l in levels" :key="l" class="flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors"
              :class="s.level === l ? 'border-foreground' : 'border-border hover:border-input'">
              <RadioGroupItem :value="l" class="mt-0.5" />
              <span>
                <span class="block text-sm font-medium" :class="l === 'none' ? 'text-destructive' : 'text-foreground'">{{ LEVEL_TEXT[l].title }}</span>
                <span class="block text-xs text-muted-foreground">{{ LEVEL_TEXT[l].text }} {{ levelLine(l) }}</span>
              </span>
            </label>
          </RadioGroup>
          <p v-if="levelsHint(chosen.length)" class="mt-3 text-xs text-muted-foreground">{{ levelsHint(chosen.length) }}</p>
        </template>

        <!-- 3. Layout -->
        <template v-else-if="step === 2">
          <h3 class="text-sm font-semibold text-foreground mb-1">Layout</h3>
          <p class="text-xs text-muted-foreground mb-3">The volume is a logical volume in an LVM volume group, so it can be expanded later without reformatting.</p>
          <div class="grid grid-cols-2 gap-3 max-w-md">
            <label class="text-xs text-muted-foreground">Volume group
              <Input v-model.trim="s.vg" class="mt-1 font-mono" maxlength="31" />
            </label>
            <label class="text-xs text-muted-foreground">Logical volume
              <Input v-model.trim="s.lv" class="mt-1 font-mono" maxlength="31" />
            </label>
          </div>
          <p v-if="lvmVGs.some(v => v.name === s.vg)" class="mt-2 status-text text-destructive"><span class="status-tag">[ERR]</span> A volume group named {{ s.vg }} already exists.</p>
          <Button variant="link" class="h-auto p-0 mt-4 text-muted-foreground hover:text-foreground" :aria-expanded="s.advanced" @click="s.advanced = !s.advanced">
            {{ s.advanced ? 'Hide advanced' : 'Advanced' }}
          </Button>
          <div v-if="s.advanced" class="mt-2 block max-w-xs text-xs text-muted-foreground">
            <span id="lv-percent-label">Use {{ s.lvPercent }}% of the volume group</span>
            <Slider
              class="mt-2"
              :model-value="[s.lvPercent]"
              :min="10" :max="100" :step="5"
              aria-labelledby="lv-percent-label"
              @update:model-value="v => { if (v?.[0] != null) s.lvPercent = v[0] }"
            />
            <span class="block mt-2">The rest stays free in the volume group, for another volume or for snapshots.</span>
          </div>
        </template>

        <!-- 4. Filesystem -->
        <template v-else-if="step === 3">
          <h3 class="text-sm font-semibold text-foreground mb-1">Filesystem</h3>
          <p class="text-xs text-muted-foreground mb-3">ext4, the standard Linux filesystem.</p>
          <label class="block max-w-xs text-xs text-muted-foreground">Label
            <Input v-model.trim="s.label" class="mt-1 font-mono" maxlength="16" />
          </label>
        </template>

        <!-- 5. Mount -->
        <template v-else-if="step === 4">
          <h3 class="text-sm font-semibold text-foreground mb-1">Where should it appear?</h3>
          <p class="text-xs text-muted-foreground mb-3">The folder the volume is mounted on, at every boot.</p>
          <label class="block max-w-md text-xs text-muted-foreground">Folder
            <Input v-model.trim="s.mountpoint" class="mt-1 font-mono" @input="s.mountEdited = true" />
          </label>
          <p v-if="mountError" class="mt-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ mountError }}</p>
        </template>

        <!-- 6. Access -->
        <template v-else-if="step === 5">
          <h3 class="text-sm font-semibold text-foreground mb-3">Who can use it?</h3>
          <RadioGroup v-model="s.access" class="gap-1.5 max-w-lg">
            <label class="flex items-start gap-3 cursor-pointer"><RadioGroupItem value="shared" class="mt-0.5" />
              <span class="text-sm text-foreground">You and the shared group<span class="block text-xs text-muted-foreground">Writable by you and by the users given write access through Places.</span></span></label>
            <label v-if="isAdmin" class="flex items-start gap-3 cursor-pointer"><RadioGroupItem value="user" class="mt-0.5" />
              <span class="text-sm text-foreground">Another user<span class="block text-xs text-muted-foreground">Owned by the user you choose, with the shared group.</span></span></label>
            <label class="flex items-start gap-3 cursor-pointer"><RadioGroupItem value="keep" class="mt-0.5" />
              <span class="text-sm text-foreground">Only root<span class="block text-xs text-muted-foreground">Left as root:root, for system use.</span></span></label>
          </RadioGroup>
          <NativeSelect wrapper-class="mt-3 max-w-xs" v-if="s.access === 'user'" v-model="s.ownerUserId" aria-label="Owner">
            <NativeSelectOption value="" disabled>Choose a user</NativeSelectOption>
            <NativeSelectOption v-for="u in users" :key="u.id" :value="u.id">{{ u.displayName || u.username }} ({{ u.username }})</NativeSelectOption>
          </NativeSelect>

          <div v-if="isAdmin" class="mt-5 space-y-3 max-w-lg">
            <label class="flex items-start gap-3 cursor-pointer"><Checkbox class="mt-1" v-model="s.createPlace" />
              <span class="text-sm text-foreground">Create a Place<span class="block text-xs text-muted-foreground">So users see it in Files. You choose who can read or write in Places.</span></span></label>
            <Input v-if="s.createPlace" v-model="s.placeName" class="max-w-xs" aria-label="Place name" maxlength="64" />
            <label v-if="s.createPlace" class="flex items-start gap-3 cursor-pointer"><Checkbox class="mt-1" v-model="s.share" />
              <span class="text-sm text-foreground">Share it over SMB<span class="block text-xs text-muted-foreground">Reachable from other computers on the network.</span></span></label>
            <Input v-if="s.createPlace && s.share" v-model.trim="s.smbName" class="max-w-xs font-mono" aria-label="Share name" maxlength="32" />
          </div>
        </template>

        <!-- 7. Review -->
        <template v-else>
          <h3 class="text-sm font-semibold text-foreground mb-3">Review</h3>
          <dl class="rounded-xl border border-border bg-card divide-y divide-border text-sm max-w-lg">
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-muted-foreground">Disks</dt><dd class="font-mono text-xs self-center">{{ chosen.map(d => `/dev/${d.name}`).join(', ') }}</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-muted-foreground">Redundancy</dt><dd>{{ LEVEL_TEXT[s.level].title }}</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-muted-foreground">LVM</dt><dd class="font-mono text-xs self-center">{{ s.vg }}/{{ s.lv }} · {{ s.lvPercent }}%</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-muted-foreground">Filesystem</dt><dd class="font-mono text-xs self-center">ext4 · {{ s.label }}</dd></div>
            <div class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-muted-foreground">Folder</dt><dd class="font-mono text-xs self-center">{{ s.mountpoint }}</dd></div>
            <div v-if="isAdmin && s.createPlace" class="flex gap-4 px-4 py-2"><dt class="w-28 shrink-0 text-muted-foreground">Place</dt><dd>{{ s.placeName }}<template v-if="s.share"> · shared as <span class="font-mono text-xs">{{ s.smbName }}</span></template></dd></div>
          </dl>
          <p class="mt-3 text-xs text-muted-foreground">Next, HSI shows every command and file change, and names the disks it erases, before anything runs.</p>
          <p v-if="error" role="alert" class="mt-3 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
        </template>
      </section>

      <!-- The volume as it will be -->
      <aside class="hidden @3xl/content:block self-start rounded-xl border border-border bg-card p-4 space-y-2">
        <p class="eyebrow">Your volume</p>
        <p><span class="font-figure font-bold text-2xl tabular-nums text-foreground">{{ fmtBytes(usable) }}</span> <span class="text-xs text-muted-foreground">usable</span></p>
        <p class="text-xs" :class="s.level === 'none' ? 'text-destructive' : 'text-foreground/80'">
          {{ LEVEL_TEXT[s.level].title }}<template v-if="tolerates"> · survives {{ tolerates }} failed {{ tolerates === 1 ? 'disk' : 'disks' }}</template>
        </p>
        <p class="text-xs text-muted-foreground">{{ chosen.length ? chosen.map(d => d.name).join(', ') : 'No disk chosen' }}</p>
        <p class="font-mono text-xs text-foreground/80">{{ s.mountpoint }}</p>
        <p v-if="isAdmin && s.createPlace" class="text-xs text-muted-foreground">Place "{{ s.placeName }}"<template v-if="s.share"> · SMB share</template></p>
      </aside>
    </div>

    <div class="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
      <Button variant="ghost" size="sm" v-if="step > 0" @click="step--">Back</Button>
      <Button variant="ghost" size="sm" v-else @click="emit('navigate', 'volumes')">Cancel</Button>
      <Button size="sm" v-if="step < STEPS.length - 1" :disabled="!canNext" @click="step++">Next: {{ STEPS[step + 1] }}</Button>
      <Button size="sm" v-else-if="done" @click="emit('navigate', 'volumes')">Go to Volumes</Button>
      <Button variant="destructive" size="sm" v-else :disabled="!chosen.length" @click="create">Create volume</Button>
    </div>
  </div>
</template>
