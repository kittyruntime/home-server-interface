<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PlusIcon } from '@lucide/vue'
import Modal from '../ui/Modal.vue'
import { GROUPS, WIDGETS, canUse, typeKey } from './registry'
import type { WidgetDef } from './registry'

// The widget catalog, by theme: each entry says what it shows. Widgets already
// on the board can be added again (two notes, two link lists).

const props = defineProps<{ viewer: { isAdmin: boolean; storage: boolean }; present: string[] }>()
const emit = defineEmits<{ close: []; add: [def: WidgetDef] }>()
const { t } = useI18n()

const groups = computed(() => GROUPS
  .map(g => ({ id: g, widgets: WIDGETS.filter(w => w.group === g && canUse(w, props.viewer)) }))
  .filter(g => g.widgets.length))
</script>

<template>
  <Modal panel-class="w-full max-w-3xl" @close="emit('close')">
    <template #header>
      <h2 class="text-base font-semibold text-base-content">{{ t('widgets.catalog.title') }}</h2>
    </template>
    <div class="flex flex-col gap-6 p-5">
      <section v-for="g in groups" :key="g.id" class="flex flex-col gap-2">
        <h3 class="eyebrow">{{ t(`widgets.groups.${g.id}`) }}</h3>
        <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <li v-for="w in g.widgets" :key="w.type">
            <button
              type="button"
              class="group flex h-full w-full items-start gap-3 rounded-box border border-base-300 p-3 text-left transition-colors duration-[var(--dur-fast)] hover:border-base-content/30 hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-primary"
              @click="emit('add', w)"
            >
              <span class="flex size-9 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/80 group-hover:bg-base-100">
                <component :is="w.icon" class="size-4" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2 text-sm font-medium text-base-content">
                  {{ t(`widgets.types.${typeKey(w.type)}.title`) }}
                  <span v-if="present.includes(w.type)" class="badge badge-ghost badge-sm shrink-0">{{ t('widgets.catalog.onBoard') }}</span>
                </span>
                <span class="mt-0.5 block text-xs text-base-content/70">{{ t(`widgets.types.${typeKey(w.type)}.description`) }}</span>
              </span>
              <PlusIcon class="mt-2 size-4 shrink-0 text-base-content/40 group-hover:text-base-content" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </Modal>
</template>
