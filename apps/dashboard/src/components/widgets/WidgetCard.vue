<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRightIcon, GripVerticalIcon, SlidersHorizontalIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { provideCardStatus } from './card-status'
import { typeKey, type WidgetDef } from './registry'
import { SIZES, type BoardWidget, type WidgetSize } from '../../lib/dashboard-boards'

// One widget on a board: a title with the app it opens, the widget's body,
// and a status line when its data is old or could not be read. In edit mode
// the header carries the handle, the sizes, the settings and the remove button.

const props = defineProps<{ widget: BoardWidget; def: WidgetDef; editing: boolean; surface?: 'panel' | 'desktop' }>()
const emit = defineEmits<{
  open: []
  resize: [size: WidgetSize]
  configure: []
  remove: []
  grab: [event: PointerEvent]
  nudge: [delta: number]
}>()

const { t } = useI18n()
const status = provideCardStatus()

const title = computed(() => {
  const custom = props.widget.settings?.title
  return typeof custom === 'string' && custom.trim() ? custom.trim() : t(`widgets.types.${typeKey(props.def.type)}.title`)
})
const settingsKey = computed(() => JSON.stringify(props.widget.settings ?? {}))
const sizes = computed(() => SIZES.filter(s => props.def.sizes.includes(s)))

function onKey(e: KeyboardEvent) {
  if (!props.editing) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); emit('nudge', -1) }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); emit('nudge', 1) }
}
</script>

<template>
  <article
    :class="[
      'card relative flex h-full min-h-0 flex-col border border-base-300 @container',
      surface === 'desktop' ? 'bg-base-100/90 backdrop-blur-sm' : 'bg-base-100',
      editing && 'outline-2 outline-dashed outline-base-content/20 outline-offset-2',
    ]"
    :aria-label="title"
  >
    <header class="flex min-h-11 items-center gap-2 pl-4 pr-2 pt-2">
      <button
        v-if="editing"
        type="button"
        class="-ml-2 flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-field text-base-content/60 hover:bg-base-200 active:cursor-grabbing"
        :aria-label="t('widgets.edit.move', { name: title })"
        @pointerdown="emit('grab', $event)"
        @keydown="onKey"
      >
        <GripVerticalIcon class="size-4" aria-hidden="true" />
      </button>
      <component :is="def.icon" v-else class="size-4 shrink-0 text-base-content/60" aria-hidden="true" />
      <h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-base-content">{{ title }}</h3>

      <template v-if="editing">
        <div v-if="sizes.length > 1" class="join" role="group" :aria-label="t('widgets.edit.size')">
          <button
            v-for="s in sizes" :key="s" type="button"
            :class="['btn btn-xs join-item min-w-8', widget.size === s ? 'btn-active' : 'btn-ghost']"
            :aria-pressed="widget.size === s"
            :title="t(`widgets.edit.sizes.${s}`)"
            @click="emit('resize', s)"
          >{{ t(`widgets.edit.sizeShort.${s}`) }}</button>
        </div>
        <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.edit.configure', { name: title })" :tooltip="t('widgets.edit.configureShort')" @click="emit('configure')">
          <SlidersHorizontalIcon aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-sm" class="hover:text-error" :aria-label="t('widgets.edit.remove', { name: title })" :tooltip="t('widgets.edit.removeShort')" @click="emit('remove')">
          <XIcon aria-hidden="true" />
        </Button>
      </template>
      <Button
        v-else-if="def.open"
        variant="ghost" size="icon-sm" class="text-base-content/60"
        :aria-label="t('widgets.open', { name: title })" :tooltip="t('widgets.openShort')"
        @click="emit('open')"
      >
        <ArrowUpRightIcon aria-hidden="true" />
      </Button>
    </header>

    <div :class="['flex min-h-0 flex-1 flex-col px-4 pb-4 pt-1', editing && 'pointer-events-none select-none opacity-70']">
      <component :is="def.component" :key="settingsKey" :widget="widget" :size="widget.size" />
    </div>

    <p v-if="status.error" class="status-text truncate px-4 pb-3 text-error" :title="status.error">
      <span class="status-tag">[ERR]</span> {{ t('widgets.unreadable') }}
    </p>
    <p v-else-if="status.stale" class="status-text truncate px-4 pb-3 text-warning">
      <span class="status-tag">[OLD]</span> {{ t('widgets.stale') }}
    </p>
  </article>
</template>
