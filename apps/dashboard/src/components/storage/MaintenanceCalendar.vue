<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { calendar, type Schedule } from './maintenance-calendar'

// The next two weeks of scheduled checks, one cell per day, from the saved
// schedules (not an unsaved draft).
const props = defineProps<{ schedules: Record<string, Schedule>; serverOffset?: number }>()
const { t, locale } = useI18n()

type Kind = 'smart' | 'raid'
const kindOf = (task: string): Kind => (task === 'raidCheck' ? 'raid' : 'smart')
// Scheduled, not a result: no green, which reads as healthy elsewhere.
const MARK: Record<Kind, string> = { smart: 'bg-info', raid: 'bg-secondary' }

const days = computed(() => calendar(props.schedules, new Date(), 14, props.serverOffset).map((d, i) => ({
  ...d,
  today: i === 0,
  kinds: [...new Set(d.tasks.map(kindOf))],
  weekday: d.date.toLocaleDateString(locale.value, { weekday: 'narrow' }),
  label: d.date.toLocaleDateString(locale.value, { weekday: 'long', day: 'numeric', month: 'long' }),
})))
const present = computed(() => (['smart', 'raid'] as Kind[]).filter(k => days.value.some(d => d.kinds.includes(k))))
</script>

<template>
  <figure class="mb-5">
    <figcaption class="mb-2 text-xs font-medium text-base-content/70">{{ t('ui.storage.MaintenanceCalendar.nextTwoWeeks') }}</figcaption>
    <ol class="grid grid-cols-7 gap-1 @xl:grid-cols-14">
      <li v-for="d in days" :key="d.date.toISOString()"
        class="flex flex-col items-center gap-1 rounded-md bg-base-200 px-0.5 py-1.5 text-xs"
        :class="d.today ? 'ring-2 ring-inset ring-base-content/40' : ''"
      >
        <span class="sr-only">{{ d.label }}: {{ d.kinds.length ? d.kinds.map(k => t(`ui.storage.MaintenanceCalendar.kind.${k}`)).join(', ') : t('ui.storage.MaintenanceCalendar.nothing') }}</span>
        <span class="text-base-content/70" aria-hidden="true">{{ d.weekday }}</span>
        <span class="font-medium tabular-nums text-base-content" aria-hidden="true">{{ d.date.getDate() }}</span>
        <span class="flex h-1.5 gap-0.5" aria-hidden="true">
          <span v-for="k in d.kinds" :key="k" class="size-1.5 rounded-full" :class="MARK[k]" />
        </span>
      </li>
    </ol>
    <p v-if="present.length" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70">
      <span v-for="k in present" :key="k" class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full" :class="MARK[k]" aria-hidden="true" />{{ t(`ui.storage.MaintenanceCalendar.kind.${k}`) }}
      </span>
    </p>
  </figure>
</template>
