<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import GettingStartedCard from './GettingStartedCard.vue'
import HttpsBanner from './HttpsBanner.vue'
import WidgetBoard from '../widgets/WidgetBoard.vue'
import StatusBand from '../widgets/StatusBand.vue'
import { canUse, widgetDef } from '../widgets/registry'
import { defaultBoards, MAX_BOARDS, useBoards } from '../../lib/dashboard-boards'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'

const { t } = useI18n()
const emit = defineEmits<{ navigate: [target: 'places' | 'store' | 'backups' | 'secure'] }>()

const { isAdmin, hasCapability } = useAuth()
const storageCap = hasCapability('storage')
const viewer = computed(() => ({ isAdmin: isAdmin.value, storage: storageCap.value }))
const store = useBoards()
const { boards, active, editing, loaded, source, saving, saveError } = store
const { confirm } = useConfirm()

const fallback = () => defaultBoards(isAdmin.value, type => canUse(widgetDef(type), viewer.value), t('widgets.boards.defaultName'))
onMounted(() => { void store.load(fallback) })

const result = ref<{ ok: boolean; text: string } | null>(null)
const boardName = computed({
  get: () => boards.value[active.value]?.name ?? '',
  set: v => store.renameBoard(active.value, v.slice(0, 40)),
})

function finishEditing() {
  const b = boards.value[active.value]
  if (b && !b.name.trim()) store.renameBoard(active.value, t('widgets.boards.defaultName'))
  editing.value = false
}

async function removeBoard() {
  const b = boards.value[active.value]
  if (!b || boards.value.length <= 1) return
  if (b.widgets.length && !await confirm(t('widgets.boards.removeConfirm', { name: b.name }), { title: t('widgets.boards.remove'), confirmLabel: t('widgets.boards.remove'), danger: true })) return
  store.removeBoard(active.value)
}

async function run(fn: () => Promise<void>, ok: string) {
  result.value = null
  try { await fn(); result.value = { ok: true, text: ok } }
  catch (e) { result.value = { ok: false, text: (e as Error).message } }
}

async function publish() {
  if (!await confirm(t('widgets.boards.publishConfirm'), { title: t('widgets.boards.publish'), confirmLabel: t('widgets.boards.publish') })) return
  await run(() => store.publish(), t('widgets.boards.published'))
}
async function unpublish() {
  await run(() => store.unpublish(), t('widgets.boards.unpublished'))
}
async function reset() {
  if (!await confirm(t('widgets.boards.resetConfirm'), { title: t('widgets.boards.reset'), confirmLabel: t('widgets.boards.reset'), danger: true })) return
  await run(() => store.reset(fallback), t('widgets.boards.resetDone'))
  editing.value = false
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Toolbar: the boards, then edit and the board menu. -->
    <div class="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-base-300 px-4 py-3 sm:px-6">
      <h3 class="sr-only">{{ t('ui.home.DashboardPanel.overview') }}</h3>
      <div v-if="!editing" role="tablist" class="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1" :aria-label="t('widgets.boards.label')">
        <button
          v-for="(b, i) in boards" :key="b.id" role="tab" type="button"
          :aria-selected="i === active"
          :class="['btn btn-sm shrink-0', i === active ? 'btn-active' : 'btn-ghost text-base-content/70']"
          @click="store.select(i)"
        >{{ b.name }}</button>
      </div>
      <div v-else class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Input v-model="boardName" class="h-8 w-44 max-w-full" maxlength="40" :aria-label="t('widgets.boards.name')" />
        <Button variant="ghost" size="icon-sm" :disabled="active === 0" :aria-label="t('widgets.boards.moveLeft')" :tooltip="t('widgets.boards.moveLeft')" @click="store.moveBoard(active, active - 1)"><ArrowLeftIcon aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-sm" :disabled="active >= boards.length - 1" :aria-label="t('widgets.boards.moveRight')" :tooltip="t('widgets.boards.moveRight')" @click="store.moveBoard(active, active + 1)"><ArrowRightIcon aria-hidden="true" /></Button>
        <Button variant="ghost" size="icon-sm" class="hover:text-error" :disabled="boards.length <= 1" :aria-label="t('widgets.boards.remove')" :tooltip="t('widgets.boards.remove')" @click="removeBoard"><Trash2Icon aria-hidden="true" /></Button>
        <span class="mx-1 h-5 w-px bg-base-300" aria-hidden="true" />
        <div role="tablist" class="flex min-w-0 items-center gap-1 overflow-x-auto" :aria-label="t('widgets.boards.label')">
          <button
            v-for="(b, i) in boards" :key="b.id" role="tab" type="button" :aria-selected="i === active"
            :class="['btn btn-xs shrink-0', i === active ? 'btn-active' : 'btn-ghost text-base-content/70']"
            @click="store.select(i)"
          >{{ b.name || '…' }}</button>
        </div>
        <Button variant="ghost" size="sm" :disabled="boards.length >= MAX_BOARDS" @click="store.addBoard(t('widgets.boards.newName', { n: boards.length + 1 }))">
          <PlusIcon aria-hidden="true" />{{ t('widgets.boards.add') }}
        </Button>
      </div>

      <span v-if="saving" class="status-text text-base-content/60">{{ t('widgets.boards.saving') }}</span>
      <Button v-if="editing" size="sm" @click="finishEditing"><CheckIcon aria-hidden="true" />{{ t('widgets.edit.done') }}</Button>
      <Button v-else variant="outline" size="sm" :disabled="!loaded" @click="editing = true"><PencilIcon aria-hidden="true" />{{ t('widgets.edit.start') }}</Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.boards.menu')"><EllipsisIcon aria-hidden="true" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-56">
          <DropdownMenuItem :disabled="source !== 'own'" @select="reset">{{ t('widgets.boards.reset') }}</DropdownMenuItem>
          <template v-if="isAdmin">
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="publish">{{ t('widgets.boards.publish') }}</DropdownMenuItem>
            <DropdownMenuItem @select="unpublish">{{ t('widgets.boards.unpublish') }}</DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="flex-1 overflow-y-auto">
      <HttpsBanner v-if="isAdmin" @navigate="emit('navigate', $event)" />
      <GettingStartedCard v-if="isAdmin" @navigate="emit('navigate', $event)" />
      <div class="flex flex-col gap-4 p-4 sm:p-6">
        <p v-if="saveError" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ t('widgets.boards.saveFailed', { error: saveError }) }}</p>
        <p v-if="result" :class="['status-text', result.ok ? 'text-success' : 'text-error']">
          <span class="status-tag">{{ result.ok ? '[OK]' : '[ERR]' }}</span> {{ result.text }}
        </p>
        <StatusBand v-if="isAdmin || storageCap" :is-admin="isAdmin" />
        <WidgetBoard v-if="loaded" :viewer="viewer" surface="panel" />
      </div>
    </div>
  </div>
</template>
