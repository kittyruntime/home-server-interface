<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { ChevronRightIcon, ExternalLinkIcon, XIcon } from '@lucide/vue'
import { dismissKey, guideUrl, isDismissed, type DocPage } from '../../lib/storage-docs'

// What a Storage tab is about, as its layers from the disks up, with links to
// the HSI guide first, then the tools' own documentation. Closing it is
// remembered in this browser.
const props = defineProps<{
  id: string
  title: string
  stages: { title: string; caption: string }[]
  note?: string
  guide: DocPage
  upstream?: { label: string; href: string }[]
}>()

const { t } = useI18n()
const dismissed = ref(isDismissed(props.id, () => globalThis.localStorage))

function dismiss() {
  dismissed.value = true
  try { localStorage.setItem(dismissKey(props.id), '1') } catch { /* private mode: shown again next time */ }
}
</script>

<template>
  <Transition name="ui-fade">
    <section v-if="!dismissed" class="relative mb-4 overflow-hidden rounded-xl border border-base-300 bg-base-100 p-4 text-base-content shadow-sm" :aria-label="title">
      <Button variant="ghost" size="icon-xs"
        :tooltip="t('ui.storage.IntroCard.dismiss')"
        :aria-label="t('ui.storage.IntroCard.dismissThisExplanation')"
        class="absolute right-3 top-3 text-base-content/70 hover:text-base-content"
        @click="dismiss"
      >
        <XIcon class="size-4" aria-hidden="true" />
      </Button>

      <h3 class="pr-8 text-sm font-semibold">{{ title }}</h3>

      <!-- The stages read as one flow: a rail with dots when narrow, a row with
           chevrons when wide. No boxes inside the card. -->
      <ol class="mt-3 flex flex-col gap-2.5 @2xl:flex-row @2xl:gap-0">
        <li v-for="(s, i) in stages" :key="s.title" class="relative flex min-w-0 flex-1 gap-3 @2xl:gap-2">
          <span class="relative flex w-2 shrink-0 justify-center @2xl:hidden" aria-hidden="true">
            <span class="mt-1.5 size-2 rounded-full bg-secondary" />
            <span v-if="i < stages.length - 1" class="absolute top-4 -bottom-3.5 w-px bg-base-300" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold text-secondary">{{ s.title }}</p>
            <p class="mt-0.5 text-xs leading-snug text-base-content/70">{{ s.caption }}</p>
          </div>
          <ChevronRightIcon v-if="i < stages.length - 1" class="mt-0.5 hidden size-4 shrink-0 text-base-content/50 @2xl:block @2xl:mr-2" aria-hidden="true" />
        </li>
      </ol>

      <p v-if="note" class="mt-3 text-xs leading-snug text-base-content/70">{{ note }}</p>

      <p class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <a :href="guideUrl(guide)" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-primary hover:underline">
          {{ t('ui.storage.IntroCard.readTheGuide') }}<ExternalLinkIcon class="size-3" aria-hidden="true" />
        </a>
        <a v-for="u in upstream ?? []" :key="u.href" :href="u.href" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-base-content/70 hover:text-base-content hover:underline">
          {{ u.label }}<ExternalLinkIcon class="size-3" aria-hidden="true" />
        </a>
      </p>
    </section>
  </Transition>
</template>
