<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PlusIcon } from '@lucide/vue'
import WidgetCard from './WidgetCard.vue'
import AddWidgetDialog from './AddWidgetDialog.vue'
import WidgetSettingsDialog from './WidgetSettingsDialog.vue'
import CustomWidgetEditor from './CustomWidgetEditor.vue'
import { canUse, widgetDef, type WidgetDef } from './registry'
import { useBoards, type BoardWidget, type WidgetSize } from '../../lib/dashboard-boards'
import { requestApp } from '../../lib/app-focus'
import { provideViewer } from './card-status'

// The widgets of the open board. In edit mode a widget moves by its handle
// (mouse, finger or arrow keys), changes size, opens its settings or goes.

const props = defineProps<{ viewer: { isAdmin: boolean; storage: boolean }; surface?: 'panel' | 'desktop' }>()
const { t } = useI18n()
const store = useBoards()
const { current, editing } = store
provideViewer(computed(() => props.viewer))

const SPAN: Record<WidgetSize, string> = {
  s: 'col-span-1',
  m: 'col-span-1 sm:col-span-2',
  l: 'col-span-1 sm:col-span-2 row-span-2',
}

const items = computed(() => (current.value?.widgets ?? []).map((w, index) => ({ w, index, def: widgetDef(w.type) }))
  .filter((x): x is { w: BoardWidget; index: number; def: WidgetDef } => !!x.def && canUse(x.def, props.viewer)))

const adding = ref(false)
const configuring = ref<{ widget: BoardWidget; def: WidgetDef } | null>(null)

function add(def: WidgetDef) {
  store.addWidget(def.type, def.size)
  adding.value = false
  // A custom widget shows nothing until it has a source: open its settings.
  const added = current.value?.widgets.at(-1)
  if (def.type === 'custom' && added?.type === 'custom') configuring.value = { widget: added, def }
}

// ── Moving ────────────────────────────────────────────────────────────────────

const dragging = ref<string | null>(null)
let dragIndex = -1

function onGrab(e: PointerEvent, w: BoardWidget, index: number) {
  if (e.button !== 0) return
  e.preventDefault()
  dragging.value = w.id
  dragIndex = index
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onDrop, { once: true })
  window.addEventListener('pointercancel', onDrop, { once: true })
}

function onMove(e: PointerEvent) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-widget-index]')
  if (!el) return
  const to = Number(el.dataset.widgetIndex)
  if (Number.isNaN(to) || to === dragIndex) return
  store.moveWidget(dragIndex, to)
  dragIndex = to
}

function onDrop() {
  dragging.value = null
  window.removeEventListener('pointermove', onMove)
}
onBeforeUnmount(onDrop)

async function nudge(w: BoardWidget, index: number, delta: number) {
  const to = index + delta
  if (to < 0 || to >= (current.value?.widgets.length ?? 0)) return
  store.moveWidget(index, to)
  await nextTick()
  document.querySelector<HTMLElement>(`[data-widget-id="${w.id}"] header button`)?.focus()
}

function open(def: WidgetDef) {
  if (def.open) requestApp(def.open.app, def.open.section)
}
</script>

<template>
  <div>
    <div class="grid grid-flow-row-dense auto-rows-[minmax(9.5rem,auto)] grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <div
        v-for="{ w, index, def } in items" :key="w.id"
        :data-widget-index="index" :data-widget-id="w.id"
        :class="[SPAN[w.size], 'min-w-0 transition-opacity duration-[var(--dur-fast)]', dragging === w.id && 'opacity-60']"
      >
        <WidgetCard
          :widget="w" :def="def" :editing="editing" :surface="surface"
          @open="open(def)"
          @resize="size => store.resizeWidget(w.id, size)"
          @configure="configuring = { widget: w, def }"
          @remove="store.removeWidget(w.id)"
          @grab="e => onGrab(e, w, index)"
          @nudge="d => nudge(w, index, d)"
        />
      </div>
      <button
        v-if="editing || !items.length"
        type="button"
        class="flex min-h-[9.5rem] flex-col items-center justify-center gap-2 rounded-box border border-dashed border-base-content/25 text-sm text-base-content/70 transition-colors duration-[var(--dur-fast)] hover:border-base-content/50 hover:bg-base-200/60 hover:text-base-content"
        @click="adding = true"
      >
        <PlusIcon class="size-5" aria-hidden="true" />
        {{ items.length ? t('widgets.edit.add') : t('widgets.edit.firstWidget') }}
      </button>
    </div>

    <AddWidgetDialog v-if="adding" :viewer="viewer" :present="items.map(i => i.w.type)" @add="add" @close="adding = false" />
    <CustomWidgetEditor
      v-if="configuring?.def.type === 'custom'" :widget="configuring.widget"
      @save="s => { store.configureWidget(configuring!.widget.id, s); configuring = null }"
      @close="configuring = null"
    />
    <WidgetSettingsDialog
      v-else-if="configuring" :widget="configuring.widget" :def="configuring.def"
      @save="s => { store.configureWidget(configuring!.widget.id, s); configuring = null }"
      @close="configuring = null"
    />
  </div>
</template>
