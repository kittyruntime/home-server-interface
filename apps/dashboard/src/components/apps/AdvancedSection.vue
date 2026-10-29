<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { XIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import { applyPlanned } from '../../lib/plan'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'

const { t } = useI18n()

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
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.composeFileRaw') }}</label>
        <span v-if="yamlDirty" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-warning border-warning/40">{{ t('ui.apps.AdvancedSection.unsaved') }}</span>
        <span v-else-if="yamlSavedAt" class="text-2xs leading-none px-1.5 py-0.5 rounded-full border text-success border-success/40">{{ t('ui.apps.AdvancedSection.saved') }}</span>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ t('ui.apps.AdvancedSection.editTheFileDirectlyFields') }} <strong>{{ t('ui.apps.AdvancedSection.apply') }}</strong>.
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
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.fieldsHsiDoesNotManage') }}</label>
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="f in unknownFields" :key="f"
          class="inline-flex items-center text-xs bg-muted text-foreground/80 border border-input rounded-sm px-2 py-0.5 font-mono"
        >{{ f }}</span>
      </div>
      <p class="text-xs text-muted-foreground">{{ t('ui.apps.AdvancedSection.preservedOnSaveEditThem') }}</p>
    </div>

    <!-- Cap Add -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.capAdd') }}</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <Badge variant="outline"
          v-for="cap in modelValue.capAdd" :key="cap"
          class="gap-1 rounded-sm text-xs bg-primary/10 text-primary border border-input"
        >
          {{ cap }}
          <Button variant="ghost" size="icon-xs" :aria-label="t('ui.apps.AdvancedSection.remove')" class="-mr-1 size-4 rounded-sm text-current opacity-70 hover:bg-transparent hover:text-current hover:opacity-100" @click="removeCap('capAdd', cap)"><XIcon class="size-3" aria-hidden="true" /></Button>
        </Badge>
      </div>
      <div class="flex gap-2">
        <Input
          v-model="capAddInput" laceholder="NET_ADMIN" @keydown.enter.prevent="addCap('capAdd', capAddInput as any)"
          class="flex-1 px-2 py-1.5 text-sm font-mono"
        />
        <Button variant="secondary" size="sm"
          @click="addCap('capAdd', capAddInput as any)"
          class="bg-primary/10 text-primary"
        >{{ t('ui.apps.AdvancedSection.add') }}</Button>
      </div>
    </div>

    <!-- Cap Drop -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.capDrop') }}</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <Badge variant="outline"
          v-for="cap in modelValue.capDrop" :key="cap"
          class="gap-1 rounded-sm text-xs bg-warning/15 text-warning border border-warning/20"
        >
          {{ cap }}
          <Button variant="ghost" size="icon-xs" :aria-label="t('ui.apps.AdvancedSection.remove')" class="-mr-1 size-4 rounded-sm text-current opacity-70 hover:bg-transparent hover:text-current hover:opacity-100" @click="removeCap('capDrop', cap)"><XIcon class="size-3" aria-hidden="true" /></Button>
        </Badge>
      </div>
      <div class="flex gap-2">
        <Input
          v-model="capDropInput" laceholder="ALL" @keydown.enter.prevent="addCap('capDrop', capDropInput as any)"
          class="flex-1 px-2 py-1.5 text-sm font-mono"
        />
        <Button variant="secondary" size="sm"
          @click="addCap('capDrop', capDropInput as any)"
          class="bg-warning/20 text-warning"
        >{{ t('ui.apps.AdvancedSection.add') }}</Button>
      </div>
    </div>

    <!-- Extra Hosts -->
    <div class="space-y-2">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.extraHosts') }}</label>
      <div class="flex flex-wrap gap-1.5 mb-2">
        <Badge variant="outline"
          v-for="h in modelValue.extraHosts" :key="h"
          class="gap-1 rounded-sm text-xs bg-muted text-foreground/80 border border-input font-mono"
        >
          {{ h }}
          <Button variant="ghost" size="icon-xs" :aria-label="t('ui.apps.AdvancedSection.remove')" class="-mr-1 size-4 rounded-sm text-current opacity-70 hover:bg-transparent hover:text-current hover:opacity-100" @click="removeExtraHost(h)"><XIcon class="size-3" aria-hidden="true" /></Button>
        </Badge>
      </div>
      <div class="flex gap-2">
        <Input
          v-model="extraHostInput" :placeholder="t('ui.apps.AdvancedSection.myhost192168110')"
          @keydown.enter.prevent="addExtraHost"
          class="flex-1 px-2 py-1.5 text-sm font-mono"
        />
        <Button variant="secondary" size="sm"
          @click="addExtraHost"
          class="bg-primary/10 text-primary"
        >{{ t('ui.apps.AdvancedSection.add') }}</Button>
      </div>
      <p v-if="extraHostError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ extraHostError }}</p>
      <p class="text-xs text-muted-foreground">{{ t('ui.apps.AdvancedSection.adds') }} <span class="font-mono">--add-host</span> {{ t('ui.apps.AdvancedSection.entriesMapsTo') }} <span class="font-mono">/etc/hosts</span> {{ t('ui.apps.AdvancedSection.insideTheContainer') }}</p>
    </div>

    <!-- Restart policy -->
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.restartPolicy') }}</label>
      <NativeSelect wrapper-class="w-full"
        :model-value="modelValue.restartPolicy"
        @change="update('restartPolicy', ($event.target as HTMLSelectElement).value)"
        class="px-2 py-1.5 text-sm"
      >
        <NativeSelectOption value="no">{{ t('ui.apps.AdvancedSection.no') }}</NativeSelectOption>
        <NativeSelectOption value="always">{{ t('ui.apps.AdvancedSection.always') }}</NativeSelectOption>
        <NativeSelectOption value="unless-stopped">{{ t('ui.apps.AdvancedSection.unlessStopped') }}</NativeSelectOption>
        <NativeSelectOption value="on-failure">{{ t('ui.apps.AdvancedSection.onFailure') }}</NativeSelectOption>
      </NativeSelect>
    </div>

    <!-- Hostname / User / Command -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.hostname') }}</label>
        <Input
          :model-value="modelValue.hostname ?? ''" :placeholder="t('ui.apps.AdvancedSection.myContainer')"
          @input="update('hostname', ($event.target as HTMLInputElement).value || null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.user') }}</label>
        <Input
          :model-value="modelValue.user ?? ''" placeholder="1000:1000"
          @input="update('user', ($event.target as HTMLInputElement).value || null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
    </div>
    <div class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.commandOverride') }}</label>
      <Input
        :model-value="modelValue.command ?? ''" laceholder="/bin/sh -c 'echo hello'"
        @input="update('command', ($event.target as HTMLInputElement).value || null)"
        class="w-full px-2 py-1.5 text-sm font-mono"
      />
    </div>

    <!-- CPU / Memory -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.cpuLimit') }}</label>
        <Input
          type="number" min="0" max="64" step="0.1"
          :model-value="modelValue.cpuLimit ?? ''" placeholder="e.g. 0.5"
          @input="update('cpuLimit', ($event.target as HTMLInputElement).value ? +($event.target as HTMLInputElement).value : null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.apps.AdvancedSection.memoryLimit') }}</label>
        <Input
          :model-value="modelValue.memoryLimit ?? ''" placeholder="e.g. 512m, 2g"
          @input="update('memoryLimit', ($event.target as HTMLInputElement).value || null)"
          class="w-full px-2 py-1.5 text-sm"
        />
      </div>
    </div>

  </div>
</template>
