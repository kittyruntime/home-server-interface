<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Item, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Button } from '@/components/ui/button'
import { XIcon } from '@lucide/vue'
import { ref } from 'vue'

const { t } = useI18n()

const emit = defineEmits<{ navigate: [target: 'places' | 'store' | 'backups'] }>()

const DISMISS_KEY = 'getting-started-dismissed'
const dismissed = ref(localStorage.getItem(DISMISS_KEY) === '1')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(DISMISS_KEY, '1')
}

const steps: Array<{ target: 'places' | 'store' | 'backups'; title: string; description: string }> = [
  { target: 'places', title: 'Add a Place', description: 'Map a server folder so you can browse, share and manage it.' },
  { target: 'store', title: 'Install an app', description: 'Deploy a self-hosted app from the curated App Store.' },
  { target: 'backups', title: 'Set up a backup plan', description: 'Keep versions of your data, or a copy elsewhere, on a schedule.' },
]
</script>

<template>
  <Transition name="ui-fade">
    <div
      v-if="!dismissed"
      class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden relative mx-4 mt-4 border-input bg-card p-4 sm:mx-6 sm:mt-5"
    >
      <Button variant="ghost" size="icon-xs"
        :tooltip="t('ui.home.GettingStartedCard.dismiss')"
        :aria-label="t('ui.home.GettingStartedCard.dismissGettingStarted')"
        class="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        @click="dismiss"
      >
        <XIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <h3 class="text-sm font-semibold text-foreground">{{ t('ui.home.GettingStartedCard.gettingStarted') }}</h3>
      <p class="mt-0.5 text-xs text-muted-foreground">{{ t('ui.home.GettingStartedCard.aFewThingsWorthSetting') }}</p>

      <div class="mt-3 grid gap-2 sm:grid-cols-3">
        <Item
          v-for="s in steps" :key="s.target"
          as="button" variant="muted"
          class="flex-col items-start gap-1 rounded-xl border-border p-3 text-left hover:border-input hover:bg-accent"
          @click="emit('navigate', s.target)"
        >
          <ItemTitle class="text-xs font-semibold">{{ s.title }}</ItemTitle>
          <ItemDescription class="text-xs">{{ s.description }}</ItemDescription>
        </Item>
      </div>
    </div>
  </Transition>
</template>
