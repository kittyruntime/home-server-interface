<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CopyIcon, ExternalLinkIcon, MonitorIcon, RefreshCwIcon, Trash2Icon } from '@lucide/vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { trpc } from '../../lib/trpc'
import { now } from '../../lib/widget-data'
import { relativeTime } from '../../lib/relative-time'
import { copyText } from '../../lib/copy-text'
import { useConfirm } from '../../lib/confirm'
import type { Board } from '../../lib/dashboard-boards'

// Wall displays of this account: a screen that shows a copy of a board
// without signing in. The link carries the display's token: it is shown once,
// and removing the display stops it at once.

const props = defineProps<{ board: Board }>()
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const { confirm } = useConfirm()

type Wall = Awaited<ReturnType<typeof trpc.dashboard.walls.query>>[number]
const walls = ref<Wall[]>([])
const created = ref<string | null>(null)
const result = ref<{ ok: boolean; text: string } | null>(null)
const busy = ref(false)

async function load() { walls.value = await trpc.dashboard.walls.query().catch(() => []) }
onMounted(load)

const payload = computed(() => ({ name: props.board.name, widgets: props.board.widgets }))
const link = computed(() => created.value ? `${location.origin}/wall#${created.value}` : '')

async function run(fn: () => Promise<unknown>, ok: string) {
  busy.value = true; result.value = null
  try { await fn(); result.value = { ok: true, text: ok }; await load() }
  catch (e) { result.value = { ok: false, text: (e as Error).message } }
  finally { busy.value = false }
}
const create = () => run(async () => { created.value = (await trpc.dashboard.createWall.mutate(payload.value)).token }, t('widgets.wall.created'))
const refresh = (w: Wall) => run(() => trpc.dashboard.updateWall.mutate({ id: w.id, ...payload.value }), t('widgets.wall.updated', { name: w.name }))
async function remove(w: Wall) {
  if (!await confirm(t('widgets.wall.removeConfirm', { name: w.name }), { title: t('widgets.wall.remove'), confirmLabel: t('widgets.wall.remove'), danger: true })) return
  await run(() => trpc.dashboard.removeWall.mutate({ id: w.id }), t('widgets.wall.removed'))
}
</script>

<template>
  <Modal panel-class="w-full max-w-2xl" @close="emit('close')">
    <template #header>
      <h2 class="text-base font-semibold text-base-content">{{ t('widgets.wall.heading') }}</h2>
    </template>
    <div class="flex flex-col gap-5 p-5">
      <p class="text-sm text-base-content/80">{{ t('widgets.wall.intro') }}</p>

      <div v-if="created" role="status" class="flex flex-col gap-2 rounded-box border border-info/40 bg-info/10 p-3">
        <p class="text-sm font-medium text-base-content">{{ t('widgets.wall.linkOnce') }}</p>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded-field bg-base-100 px-2 py-1.5 font-mono text-2xs">{{ link }}</code>
          <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.source.copy')" :tooltip="t('widgets.source.copy')" @click="copyText(link)"><CopyIcon aria-hidden="true" /></Button>
          <a :href="link" target="_blank" rel="noopener" class="btn btn-ghost btn-sm btn-square" :aria-label="t('widgets.wall.open')"><ExternalLinkIcon class="size-4" aria-hidden="true" /></a>
        </div>
        <p class="text-xs text-base-content/70">{{ t('widgets.wall.linkHint') }}</p>
      </div>

      <div class="flex flex-col gap-2">
        <h3 class="eyebrow">{{ t('widgets.wall.list') }}</h3>
        <p v-if="!walls.length" class="text-sm text-base-content/60">{{ t('widgets.wall.none') }}</p>
        <ul v-else class="flex flex-col divide-y divide-base-300 rounded-box border border-base-300">
          <li v-for="w in walls" :key="w.id" class="flex items-center gap-3 px-3 py-2">
            <MonitorIcon class="size-4 shrink-0 text-base-content/60" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-base-content">{{ w.name }} <span class="font-mono text-2xs font-normal text-base-content/60">{{ w.prefix }}…</span></p>
              <p class="text-xs text-base-content/60">
                {{ t('widgets.wall.widgets', { n: w.widgets }, w.widgets) }} ·
                {{ w.lastSeenAt ? t('widgets.wall.seen', { at: relativeTime(w.lastSeenAt, now, locale) }) : t('widgets.wall.neverSeen') }}
              </p>
            </div>
            <Button variant="ghost" size="sm" :disabled="busy" :tooltip="t('widgets.wall.refreshHint', { name: board.name })" @click="refresh(w)"><RefreshCwIcon aria-hidden="true" />{{ t('widgets.wall.refresh') }}</Button>
            <Button variant="ghost" size="icon-sm" class="hover:text-error" :disabled="busy" :aria-label="t('widgets.wall.removeNamed', { name: w.name })" @click="remove(w)"><Trash2Icon aria-hidden="true" /></Button>
          </li>
        </ul>
      </div>
      <p v-if="result" :class="['status-text', result.ok ? 'text-success' : 'text-error']"><span class="status-tag">{{ result.ok ? '[OK]' : '[ERR]' }}</span> {{ result.text }}</p>
    </div>
    <template #footer>
      <div class="flex w-full justify-end gap-2 px-5 py-4">
        <Button variant="ghost" @click="emit('close')">{{ t('common.close') }}</Button>
        <Button :disabled="busy || walls.length >= 10" @click="create"><MonitorIcon aria-hidden="true" />{{ t('widgets.wall.create', { name: board.name }) }}</Button>
      </div>
    </template>
  </Modal>
</template>
