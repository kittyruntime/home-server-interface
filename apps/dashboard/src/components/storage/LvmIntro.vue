<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ChevronRightIcon, XIcon } from '@lucide/vue'
import { ref } from 'vue'

const { t } = useI18n()

const DISMISS_KEY = 'lvm-intro-dismissed'
const dismissed = ref(localStorage.getItem(DISMISS_KEY) === '1')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(DISMISS_KEY, '1')
}

const stages = [
  {
    title: t('uis.storage.LvmIntro.disks'),
    caption: t('ui.storage.LvmIntro.disksCaption'),
  },
  {
    title: t('uis.storage.LvmIntro.volumeGroup'),
    caption: t('ui.storage.LvmIntro.volumeGroupCaption'),
  },
  {
    title: t('uis.storage.LvmIntro.logicalVolumes'),
    caption: t('ui.storage.LvmIntro.logicalVolumesCaption'),
  },
]
</script>

<template>
  <Transition name="ui-fade">
    <div v-if="!dismissed" class="rounded-xl border bg-base-100 text-base-content shadow-sm overflow-hidden relative mb-4 border-base-300 bg-base-100 p-4">
      <Button variant="ghost" size="icon-xs"
        :tooltip="t('ui.storage.LvmIntro.dismiss')"
        :aria-label="t('ui.storage.LvmIntro.dismissLvmExplanation')"
        class="absolute right-3 top-3 text-base-content/70 hover:text-base-content"
        @click="dismiss"
      >
        <XIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <h3 class="text-sm font-semibold text-base-content pr-8">{{ t('ui.storage.LvmIntro.howLvmWorks') }}</h3>

      <div class="mt-3 flex flex-col @2xl:flex-row @2xl:items-center gap-2 @2xl:gap-1">
        <template v-for="(s, i) in stages" :key="s.title">
          <div class="flex-1 min-w-0 rounded-xl border border-base-300 bg-base-200 p-3">
            <p class="text-xs font-semibold text-secondary">{{ s.title }}</p>
            <p class="mt-1 text-xs text-base-content/70 leading-snug">{{ s.caption }}</p>
          </div>
          <div v-if="i < stages.length - 1" class="flex items-center justify-center shrink-0 text-base-content/70">
            <ChevronRightIcon class="w-4 h-4 rotate-90 @2xl:rotate-0" aria-hidden="true" />
          </div>
        </template>
      </div>

      <p class="mt-3 text-xs text-base-content/70 leading-snug">
        {{ t('ui.storage.LvmIntro.useLvmToCombineDrives') }} <strong class="text-base-content/80">{{ t('ui.storage.LvmIntro.disks') }}</strong> {{ t('ui.storage.LvmIntro.isSimpler') }}
      </p>
    </div>
  </Transition>
</template>
