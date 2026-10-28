<script setup lang="ts">
import { XIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import { applyPlanned } from '../../lib/plan'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'

export interface AdvancedConfig {
  capAdd:        string[]
  capDrop:       string[]
  extraHosts:    string[]
  restartPolicy: string
  hostname:      string | null
  user:          string | null
  command:       string | null
  cpuLimit:      number | null
  memoryLimit:   string | null
}

const props = defineProps<{
  modelValue: AdvancedConfig
  appName?: string | null
  unknownFields?: string[]
  rawYaml?: string
}>()
const emit  = defineEmits<{
  'update:modelValue': [v: AdvancedConfig]
  'raw-saved': [content: string]
}>()

const capAddInput     = ref('')
const capDropInput    = ref('')
const extraHostInput  = ref('')
const extraHostError  = ref('')

// Raw compose file editor. The server validates the file (at least one
// service) on save - no client-side sanity check needed here.
const yamlDraft    = ref(props.rawYaml ?? '')
const yamlDirty    = ref(false)
const yamlSaving   = ref(false)
const yamlError    = ref('')
const yamlSavedAt  = ref(false)

watch(() => props.rawYaml, (v) => {
  yamlDraft.value = v ?? ''
  yamlDirty.value = false
  yamlError.value = ''
  yamlSavedAt.value = false
})

async function saveRawYaml() {
  yamlError.value = ''
  yamlSavedAt.value = false
  if (!props.appName) { yamlError.value = 'Save the app first to get a name.'; return }
  yamlSaving.value = true
  try {
    await applyPlanned('app.save', { name: props.appName, raw: yamlDraft.value }, {
      domain: 'apps', title: `Save the compose file of ${props.appName}`, actionLabel: 'Save',
    })
    yamlDirty.value = false
    yamlSavedAt.value = true
    emit('raw-saved', yamlDraft.value)
  } catch (e: any) {
    yamlError.value = e?.message ?? 'Failed to save the file'
  } finally {
    yamlSaving.value = false
  }
}

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

function addExtraHost() {
  extraHostError.value = ''
  const h = extraHostInput.value.trim()
  if (!h) return
  if (!/^[^:]+:[^:]+$/.test(h)) { extraHostError.value = 'Format: hostname:ip'; return }
  if (!props.modelValue.extraHosts.includes(h)) {
    update('extraHosts', [...props.modelValue.extraHosts, h])
  }
  extraHostInput.value = ''
}

function removeExtraHost(h: string) {
  update('extraHosts', props.modelValue.extraHosts.filter(x => x !== h))
}
</script>

<template>
  <div class="space-y-5">

    <!-- Raw compose file (always visible in the advanced tab) -->
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Compose file (raw)</label>
        <span v-if="yamlDirty" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40">Unsaved</span>
        <span v-else-if="yamlSavedAt" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-success border-success/40">Saved</span>
      </div>
      <p class="text-xs text-muted-foreground">
        Edit the file directly. Fields HSI does not manage are preserved on save; changes apply on the next <strong>Apply</strong>.
      </p>
      <Textarea
        v-model="yamlDraft"
        @input="yamlDirty = true; yamlSavedAt = false; yamlError = ''"
        spellcheck="false"
        rows="16"
        class="w-full px-3 py-2 text-xs font-mono font-mono resize-y"
      />
      <div class="flex items-center gap-3">
        <p v-if="yamlError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ yamlError }}</p>
        <div v-else class="flex-1" />
        <Button size="sm"
          @click="saveRawYaml"
          :disabled="yamlSaving || !appName || !yamlDirty"
        >
          {{ yamlSaving ? 'Saving…' : 'Save file' }}
        </Button>
      </div>
    </div>

    <!-- Fields HSI does not manage -->
    <div v-if="unknownFields && unknownFields.length" class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Fields HSI does not manage</label>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="f in unknownFields" :key="f"
          class="inline-flex items-center text-xs bg-muted text-foreground/80 border border-input rounded-sm px-2 py-0.5 font-mono"
        >{{ f }}</span>
      </div>
      <p class="text-xs text-muted-foreground">Preserved on save - edit them in the file above.</p>
    </div>

    <!-- Cap Add -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Cap Add</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span
          v-for="cap in modelValue.capAdd" :key="cap"
          class="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary border border-input rounded-sm px-2 py-0.5"
        >
          {{ cap }}
          <button type="button" aria-label="Remove" class="rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 outline-none" @click="removeCap('capAdd', cap)"><XIcon class="size-3" aria-hidden="true" /></button>
        </span>
      </div>
      <div class="flex gap-2">
        <Input
          v-model="capAddInput" placeholder="NET_ADMIN" @keydown.enter.prevent="addCap('capAdd', capAddInput as any)"
          class="flex-1 px-2 py-1.5 text-sm font-mono"
        />
        <Button variant="secondary" size="sm"
          @click="addCap('capAdd', capAddInput as any)"
          class="bg-primary/10 text-primary"
        >Add</Button>
      </div>
    </div>

    <!-- Cap Drop -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Cap Drop</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span
          v-for="cap in modelValue.capDrop" :key="cap"
          class="inline-flex items-center gap-1 text-xs bg-warning/15 text-warning border border-warning/20 rounded-sm px-2 py-0.5"
        >
          {{ cap }}
          <button type="button" aria-label="Remove" class="rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 outline-none" @click="removeCap('capDrop', cap)"><XIcon class="size-3" aria-hidden="true" /></button>
        </span>
      </div>
      <div class="flex gap-2">
        <Input
          v-model="capDropInput" placeholder="ALL" @keydown.enter.prevent="addCap('capDrop', capDropInput as any)"
          class="flex-1 px-2 py-1.5 text-sm font-mono"
        />
        <Button variant="secondary" size="sm"
          @click="addCap('capDrop', capDropInput as any)"
          class="bg-warning/20 text-warning"
        >Add</Button>
      </div>
    </div>

    <!-- Extra Hosts -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Extra Hosts</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <span
          v-for="h in modelValue.extraHosts" :key="h"
          class="inline-flex items-center gap-1 text-xs bg-muted text-foreground/80 border border-input rounded-sm px-2 py-0.5 font-mono"
        >
          {{ h }}
          <button type="button" aria-label="Remove" class="rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 outline-none" @click="removeExtraHost(h)"><XIcon class="size-3" aria-hidden="true" /></button>
        </span>
      </div>
      <div class="flex gap-2">
        <Input
          v-model="extraHostInput" placeholder="myhost:192.168.1.10"
          @keydown.enter.prevent="addExtraHost"
          class="flex-1 px-2 py-1.5 text-sm font-mono"
        />
        <Button variant="secondary" size="sm"
          @click="addExtraHost"
          class="bg-primary/10 text-primary"
        >Add</Button>
      </div>
      <p v-if="extraHostError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ extraHostError }}</p>
      <p class="text-xs text-muted-foreground">Adds <span class="font-mono">--add-host</span> entries (maps to <span class="font-mono">/etc/hosts</span> inside the container).</p>
    </div>

    <!-- Restart policy -->
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Restart Policy</label>
      <NativeSelect wrapper-class="w-full"
        :model-value="modelValue.restartPolicy"
        @change="update('restartPolicy', ($event.target as HTMLSelectElement).value)"
        class="px-2 py-1.5 text-sm"
      >
        <NativeSelectOption value="no">No</NativeSelectOption>
        <NativeSelectOption value="always">Always</NativeSelectOption>
        <NativeSelectOption value="unless-stopped">Unless Stopped</NativeSelectOption>
        <NativeSelectOption value="on-failure">On Failure</NativeSelectOption>
      </NativeSelect>
    </div>

    <!-- Hostname / User / Command -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Hostname</label>
        <Input
          :model-value="modelValue.hostname ?? ''" placeholder="my-container"
          @input="update('hostname', ($event.target as HTMLInputElement).value || null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">User</label>
        <Input
          :model-value="modelValue.user ?? ''" placeholder="1000:1000"
          @input="update('user', ($event.target as HTMLInputElement).value || null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
    </div>
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Command override</label>
      <Input
        :model-value="modelValue.command ?? ''" placeholder="/bin/sh -c 'echo hello'"
        @input="update('command', ($event.target as HTMLInputElement).value || null)"
        class="w-full px-2 py-1.5 text-sm font-mono"
      />
    </div>

    <!-- CPU / Memory -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">CPU Limit</label>
        <Input
          type="number" min="0" max="64" step="0.1"
          :model-value="modelValue.cpuLimit ?? ''" placeholder="e.g. 0.5"
          @input="update('cpuLimit', ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">Memory Limit</label>
        <Input
          :model-value="modelValue.memoryLimit ?? ''" placeholder="e.g. 512m, 2g"
          @input="update('memoryLimit', ($event.target as HTMLInputElement).value || null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
    </div>

  </div>
</template>
