<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import PlaceIcon from './PlaceIcon.vue'

const { t } = useI18n()

// Picks the emoji of a place: a few suggestions, any emoji typed or pasted,
// or back to the folder icon.
const props = defineProps<{ icon?: string | null; name: string }>()
const emit = defineEmits<{ change: [icon: string | null] }>()

const SUGGESTIONS = [
  '📁', '🗂️', '🏠', '👪', '📷', '🎬', '🎵', '🎮', '📚', '💼',
  '💾', '🗄️', '☁️', '🔒', '🧪', '🛠️', '📦', '🖼️', '📺', '⭐',
]

const open = ref(false)
const custom = ref('')
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function isSingleEmoji(value: string) {
  return [...graphemes.segment(value)].length === 1 && /^\p{RGI_Emoji}$/v.test(value)
}

function pick(icon: string | null) {
  open.value = false
  custom.value = ''
  if (icon !== (props.icon ?? null)) emit('change', icon)
}

function pickCustom() {
  // A bare symbol such as ❤ needs the emoji variation selector.
  const value = custom.value.trim()
  const candidate = isSingleEmoji(value) ? value : `${value}️`
  if (isSingleEmoji(candidate)) pick(candidate)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="icon-sm" :tooltip="'Change icon'" :aria-label="`Change the icon of ${name}`" class="shrink-0 text-base text-primary">
        <PlaceIcon :icon="icon" class="size-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-64 space-y-3">
      <div class="grid grid-cols-5 gap-1">
        <Button v-for="emoji in SUGGESTIONS" :key="emoji" variant="ghost" size="icon"
          :aria-label="emoji" :aria-pressed="icon === emoji"
          :class="['text-xl', icon === emoji && 'bg-accent']" @click="pick(emoji)">
          {{ emoji }}
        </Button>
      </div>
      <form class="flex gap-2" @submit.prevent="pickCustom">
        <Input v-model="custom" maxlength="16" :placeholder="t('ui.settings.PlaceIconPicker.anyEmoji')" :aria-label="t('ui.settings.PlaceIconPicker.anyEmoji')" class="h-8 text-base" />
        <Button type="submit" size="sm" :disabled="!custom.trim()">{{ t('ui.settings.PlaceIconPicker.use') }}</Button>
      </form>
      <Button variant="ghost" size="sm" class="w-full" :disabled="!icon" @click="pick(null)">{{ t('ui.settings.PlaceIconPicker.useTheFolderIcon') }}</Button>
    </PopoverContent>
  </Popover>
</template>
