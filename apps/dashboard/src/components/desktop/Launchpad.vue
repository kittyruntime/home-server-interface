<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { computed, ref, useId } from 'vue'
import { useDesktop, APP_LABEL, type AppId } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import { navCapability } from '../../lib/assistant'
import { useAlerts } from '../../composables/useAlerts'
import { useNativeDialog } from '../../lib/native-dialog'
import AppIcon from './AppIcon.vue'

const { t } = useI18n()

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()
const { isAdmin } = useAuth()
const { alerts, hasAlerts } = useAlerts()

/* Full-screen native dialog: Escape and a click on the empty backdrop close
   it; the parent unmounts it on @close, once the leave animation has played. */
const titleId = useId()
const el = ref<HTMLElement | null>(null)
const { open, requestClose, finish, onCancel, onNativeClose, onPointerdown, onClick } = useNativeDialog(el, {
  closeOnBackdrop: () => true,
  focus: 'button:not(:disabled)',
  onClosed: () => emit('close'),
})

const allApps: { id: AppId; adminOnly: boolean; capability?: string }[] = [
  { id: 'files',   adminOnly: false },
  { id: 'apps',    adminOnly: false },
  { id: 'storage', adminOnly: true, capability: 'storage' },
  { id: 'store',   adminOnly: true },
  { id: 'monitor', adminOnly: true },
  { id: 'sharing', adminOnly: true },
  { id: 'assistant', adminOnly: true, capability: 'assistant' },
  { id: 'settings', adminOnly: false },
]

const visibleApps = computed(() =>
  allApps
    .filter(a => !a.adminOnly || isAdmin.value || (a.capability != null && navCapability(a.capability)))
    .map(a => a.id)
)

function launch(id: AppId) {
  openApp(id)
  requestClose()
}
</script>

<template>
  <dialog
    ref="el"
    :aria-labelledby="titleId"
    :class="['modal bg-base-100 transition-opacity', { 'pointer-events-none opacity-0': !open }]"
    :style="{ transitionDuration: 'var(--dur-slow)' }"
    @cancel="onCancel"
    @close="onNativeClose"
    @pointerdown="onPointerdown"
    @click="onClick"
  >
    <Transition name="ui-pop" appear @after-leave="finish">
      <div v-if="open" class="[--ui-dur:var(--dur-slow)]">
        <h2 :id="titleId" class="sr-only">{{ t('ui.desktop.Launchpad.launchpad') }}</h2>
        <div class="grid grid-cols-4 gap-8 p-8">
          <Button
            v-for="id in visibleApps"
            :key="id"
            variant="ghost"
            @click="launch(id)"
            class="h-auto flex-col gap-3 p-4 rounded-xl font-normal whitespace-normal focus-visible:bg-base-200"
          >
            <div class="relative size-16 rounded-xl bg-card border shadow-xs flex items-center justify-center text-foreground/80">
              <AppIcon :app="id" :stroke-width="1.5" class="size-7" />
              <span v-if="id === 'storage' && hasAlerts('storage.')"
                class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
              <span v-else-if="id === 'monitor' && alerts.length"
                class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
            </div>
            <span class="eyebrow">{{ APP_LABEL[id] }}</span>
          </Button>
        </div>
      </div>
    </Transition>
  </dialog>
</template>
