<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { LinkIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { useAuth } from '../../../lib/auth'
import { injectViewer } from '../card-status'
import { parseLinks } from '../links'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const viewer = injectViewer()
const { isAdmin: signedInAdmin } = useAuth()
const isAdmin = computed(() => viewer ? viewer.value.isAdmin : signedInAdmin.value)
const links = computed(() => parseLinks(props.widget.settings?.links))

// The server checks the addresses (admins only: it can reach the whole local
// network). The card mounts the widget again when the links change.
const urls = links.value.map(l => l.url)
const status = isAdmin.value && urls.length
  ? useSource(`links:${urls.join('|')}`, () => trpc.dashboard.linkStatus.query({ urls }), 60_000)
  : null
const byUrl = computed(() => new Map((status?.data.value ?? []).map(s => [s.url, s])))
const initial = (label: string) => label.trim().charAt(0).toUpperCase() || '?'
</script>

<template>
  <Empty v-if="!links.length" :icon="LinkIcon" :text="t('widgets.links.empty')" />
  <ul v-else :class="['-mx-2 grid flex-1 content-start gap-0.5', props.size === 's' ? 'grid-cols-1' : 'grid-cols-1 @[22rem]:grid-cols-2']">
    <li v-for="l in links" :key="l.url">
      <a
        :href="l.url" target="_blank" rel="noopener noreferrer"
        class="flex items-center gap-2.5 rounded-field px-2 py-1.5 hover:bg-base-200"
      >
        <span class="flex size-7 shrink-0 items-center justify-center rounded-field bg-base-200 text-xs font-semibold text-base-content/80" aria-hidden="true">{{ initial(l.label) }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-base-content">{{ l.label }}</span>
          <span class="block truncate font-mono text-2xs text-base-content/60">{{ l.url.replace(/^https?:\/\//, '') }}</span>
        </span>
        <span v-if="byUrl.get(l.url)" class="flex shrink-0 items-center gap-1 text-2xs" :class="byUrl.get(l.url)!.up ? 'text-success' : 'text-error'">
          <span :class="['size-2 rounded-full', byUrl.get(l.url)!.up ? 'bg-success' : 'bg-error']" aria-hidden="true" />
          {{ byUrl.get(l.url)!.up ? (byUrl.get(l.url)!.ms != null ? `${byUrl.get(l.url)!.ms} ms` : t('widgets.links.up')) : t('widgets.links.down') }}
        </span>
      </a>
    </li>
  </ul>
</template>
