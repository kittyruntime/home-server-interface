<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import PhysicalDisksSection from './PhysicalDisksSection.vue'
import RaidSection from './RaidSection.vue'
import LvmSection from './LvmSection.vue'
import MountsSection from './MountsSection.vue'
import { useHostTools } from './tools'

type SectionId = 'disks' | 'raid' | 'lvm' | 'mounts'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'disks',  label: 'Devices' },
  { id: 'raid',   label: 'RAID' },
  { id: 'lvm',    label: 'LVM' },
  { id: 'mounts', label: 'Mounts' },
]

const active = ref<SectionId>('disks')

function focusOn(section: SectionId) {
  active.value = section
}

// Free disks picked in Devices, handed to the RAID or LVM create wizard.
const preselect = ref<{ kind: 'raid' | 'lvm'; devices: string[] } | null>(null)
function startCreate(kind: 'raid' | 'lvm', devices: string[]) {
  preselect.value = { kind, devices }
  active.value = kind
}

const { load: loadTools, missingStorageTools } = useHostTools()
onMounted(() => { void loadTools() })
const missingTools = computed(() => missingStorageTools())
const installCommand = computed(() =>
  `sudo apt install ${[...new Set(missingTools.value.map(t => t.package))].join(' ')}`)
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <!-- Mobile picker -->
    <div class="sm:hidden flex-shrink-0 border-b border-[var(--c-border)] bg-[var(--c-sidebar)] px-4 py-2.5">
      <select v-model="active" class="w-full bg-transparent text-sm text-[var(--c-text-2)] focus:outline-none">
        <option v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>

    <!-- Left nav -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
        <span
          v-if="active === item.id"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--c-accent)] rounded-r-full"
        />
        <button
          @click="active = item.id"
          :class="[
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
            active === item.id
              ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
              : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
          ]"
        >
          <!-- Disks -->
          <svg v-if="item.id === 'disks'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M22 12H2"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 16h.01M10 16h.01"/>
          </svg>
          <!-- RAID -->
          <svg v-else-if="item.id === 'raid'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/>
          </svg>
          <!-- LVM -->
          <svg v-else-if="item.id === 'lvm'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M3 12h18M3 17h18"/>
          </svg>
          <!-- Mounts -->
          <svg v-if="item.id === 'mounts'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/>
          </svg>
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-4 sm:p-8 max-w-5xl">
        <div v-if="missingTools.length" role="status"
          class="mb-5 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
          <p class="text-[var(--c-text-1)]">
            Some storage tools are not installed on the server, so these features are unavailable:
            {{ missingTools.map(t => `${t.feature} (${t.command})`).join(', ') }}.
          </p>
          <p class="mt-1 text-[var(--c-text-3)]">Install them with <code class="font-mono text-[var(--c-text-2)]">{{ installCommand }}</code></p>
        </div>
        <PhysicalDisksSection v-if="active === 'disks'"  @navigate="focusOn" @create="startCreate" />
        <RaidSection          v-else-if="active === 'raid'"   @navigate="focusOn"
          :preselect="preselect?.kind === 'raid' ? preselect.devices : undefined" @preselected="preselect = null" />
        <LvmSection           v-else-if="active === 'lvm'"
          :preselect="preselect?.kind === 'lvm' ? preselect.devices : undefined" @preselected="preselect = null" />
        <MountsSection        v-else-if="active === 'mounts'" @navigate="focusOn" />
      </div>
    </div>

  </div>
</template>
