<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ArchiveIcon, ChevronRightIcon, FolderPlusIcon, StoreIcon, XIcon } from '@lucide/vue'
import type { Component } from 'vue'
import { ref } from 'vue'

const { t } = useI18n()

const emit = defineEmits<{ navigate: [target: 'places' | 'store' | 'backups'] }>()

const DISMISS_KEY = 'getting-started-dismissed'
const dismissed = ref(localStorage.getItem(DISMISS_KEY) === '1')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(DISMISS_KEY, '1')
}

const steps: Array<{ target: 'places' | 'store' | 'backups'; icon: Component; title: string; description: string }> = [
  { target: 'places', icon: FolderPlusIcon, title: t('uis.home.GettingStartedCard.addAPlace'), description: t('uis.home.GettingStartedCard.mapAServerFolderSo') },
  { target: 'store', icon: StoreIcon, title: t('uis.home.GettingStartedCard.installAnApp'), description: t('uis.home.GettingStartedCard.deployASelfHostedApp') },
  { target: 'backups', icon: ArchiveIcon, title: t('uis.home.GettingStartedCard.setUpABackupPlan'), description: t('uis.home.GettingStartedCard.keepVersionsOfYourData') },
]
</script>

<template>
  <Transition name="ui-fade">
    <section
      v-if="!dismissed"
      class="relative mx-4 mt-4 rounded-box border border-base-300 bg-base-100 px-5 py-4 text-base-content sm:mx-6 sm:mt-5"
      :aria-labelledby="'getting-started-title'"
    >
      <Button variant="ghost" size="icon-xs"
        :tooltip="t('ui.home.GettingStartedCard.dismiss')"
        :aria-label="t('ui.home.GettingStartedCard.dismissGettingStarted')"
        class="absolute right-3 top-3 text-base-content/70 hover:text-base-content"
        @click="dismiss"
      >
        <XIcon class="size-4" aria-hidden="true" />
      </Button>

      <h3 id="getting-started-title" class="pr-8 text-sm font-semibold">{{ t('ui.home.GettingStartedCard.gettingStarted') }}</h3>
      <p class="mt-0.5 text-xs text-base-content/70">{{ t('ui.home.GettingStartedCard.aFewThingsWorthSetting') }}</p>

      <ul class="mt-3 grid divide-y divide-base-300 md:grid-cols-3 md:gap-x-6 md:divide-y-0">
        <li v-for="s in steps" :key="s.target">
          <button type="button"
            class="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 md:items-start rounded-field px-2 py-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            @click="emit('navigate', s.target)">
            <span class="grid size-8 shrink-0 place-items-center rounded-field bg-primary/10 text-primary" aria-hidden="true"><component :is="s.icon" class="size-4" /></span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{{ s.title }}</span>
              <span class="mt-0.5 block text-xs text-base-content/70">{{ s.description }}</span>
            </span>
            <ChevronRightIcon class="size-4 shrink-0 self-center text-base-content/50 transition-transform duration-(--dur-fast) group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
  </Transition>
</template>
