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

      <div class="mt-3 flex flex-col gap-2 @2xl:flex-row @2xl:items-center @2xl:gap-1">
        <template v-for="(s, i) in stages" :key="s.title">
          <div class="min-w-0 flex-1 rounded-xl border border-base-300 bg-base-200 p-3">
            <p class="text-xs font-semibold text-secondary">{{ s.title }}</p>
            <p class="mt-1 text-xs leading-snug text-base-content/70">{{ s.caption }}</p>
          </div>
          <div v-if="i < stages.length - 1" class="flex shrink-0 items-center justify-center text-base-content/70">
            <ChevronRightIcon class="size-4 rotate-90 @2xl:rotate-0" aria-hidden="true" />
          </div>
        </template>
      </div>

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
