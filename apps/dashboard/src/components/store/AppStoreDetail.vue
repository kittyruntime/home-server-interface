<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { computed, onMounted, ref } from 'vue'
import type { trpc } from '../../lib/trpc'
import { updateText } from '../../lib/app-update'
import { appPermissions } from '../../lib/app-permissions'
import { versionLabel } from '../../lib/store'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const props = defineProps<{
  app: Entry
  state: { label: string; dot: string; text: string }
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ back: []; install: []; open: []; update: []; rollback: [] }>()

const inst = computed(() => props.app.installedApp)
const version = computed(() => versionLabel(props.app))
const canOpen = computed(() => !!inst.value && (inst.value.webUrl != null || inst.value.webPort != null))
const permissions = computed(() => appPermissions(props.app))

// The grid card that opened this page is gone: keyboard focus starts here.
const backButton = ref<InstanceType<typeof Button> | null>(null)
onMounted(() => (backButton.value?.$el as HTMLElement | undefined)?.focus())
</script>

<template>
  <div class="max-w-3xl space-y-4">
    <Button variant="ghost" size="sm" ref="backButton" @click="emit('back')" @keydown.esc="emit('back')">{{ t('ui.store.AppStoreDetail.back') }}</Button>

    <Card class="block gap-0 py-0 overflow-hidden p-5 space-y-5">
      <!-- Identity + main action -->
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <!-- eslint-disable-next-line vue/no-v-html -- `app.icon` is a bundled first-party brand logo from @app/app-catalog, not user input. -->
        <span class="w-14 h-14 shrink-0 grid place-items-center" v-html="app.icon" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-base font-semibold text-foreground">{{ app.name }}</h3>
            <span class="text-2xs uppercase tracking-caps text-muted-foreground">{{ app.category }}</span>
          </div>
          <p class="text-sm text-foreground/80 mt-0.5">{{ app.tagline }}</p>
          <p class="text-xs mt-2 flex items-center gap-3 flex-wrap">
            <span class="inline-flex items-center gap-1.5" :class="state.text">
              <span v-if="state.dot" class="w-1.5 h-1.5 rounded-full" :class="state.dot" />
              {{ state.label }}
            </span>
            <span v-if="version" class="text-muted-foreground font-mono">{{ version }}</span>
          </p>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap shrink-0">
          <Button size="sm" v-if="!inst" @click="emit('install')">{{ t('ui.store.AppStoreDetail.install') }}</Button>
          <Button size="sm" v-if="inst?.update" :disabled="busy" @click="emit('update')">{{ t('ui.store.AppStoreDetail.update') }}</Button>
          <Button variant="outline" size="sm" v-if="canOpen" @click="emit('open')">{{ t('ui.store.AppStoreDetail.open') }}</Button>
        </div>
      </div>

      <!-- Update / rollback -->
      <div v-if="inst?.update || inst?.rollbackTo" class="rounded-lg border border-border p-3 space-y-2">
        <p v-if="inst?.update" class="text-xs text-warning flex items-center gap-2 flex-wrap">
          <span>{{ updateText(inst.update) }}</span>
          <a v-if="app.changelog" :href="app.changelog" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground">{{ t('ui.store.AppStoreDetail.whatSNew') }}</a>
        </p>
        <div v-if="inst?.rollbackTo" class="flex items-center justify-between gap-2 flex-wrap">
          <p class="text-xs text-muted-foreground">{{ t('uip.store.AppStoreDetail.thePreviousVersionIsKept', { p0: inst.rollbackTo }) }}</p>
          <Button variant="outline" size="xs" :disabled="busy" @click="emit('rollback')">{{ t('uip.store.AppStoreDetail.rollBackTo', { p0: inst.rollbackTo }) }}</Button>
        </div>
      </div>
      <p v-if="error" role="alert" class="status-text text-destructive break-words"><span class="status-tag">[ERR]</span> {{ error }}</p>

      <!-- About -->
      <div class="space-y-2">
        <h4 class="eyebrow">{{ t('ui.store.AppStoreDetail.about') }}</h4>
        <p class="text-sm text-foreground/80 leading-relaxed">{{ app.description }}</p>
        <div v-if="app.services?.length" class="text-xs">
          <span class="text-muted-foreground">{{ t('ui.store.AppStoreDetail.installsWith') }} </span>
          <template v-for="(sc, i) in app.services" :key="sc.name">
            <span v-if="i" class="text-muted-foreground">, </span>
            <span class="text-foreground/80">{{ sc.label }}</span>
            <span class="font-mono text-muted-foreground"> ({{ sc.image }})</span>
          </template>
        </div>
        <p class="text-xs flex gap-4 flex-wrap">
          <a v-if="app.website" :href="app.website" target="_blank" rel="noopener noreferrer" class="underline text-muted-foreground hover:text-foreground">{{ t('ui.store.AppStoreDetail.website') }}</a>
          <a v-if="app.changelog" :href="app.changelog" target="_blank" rel="noopener noreferrer" class="underline text-muted-foreground hover:text-foreground">{{ t('ui.store.AppStoreDetail.releaseNotes') }}</a>
        </p>
      </div>

      <section v-if="permissions.length" class="space-y-2" aria-labelledby="perm-heading">
        <h4 id="perm-heading" class="eyebrow">{{ t('ui.store.AppStoreDetail.permissions') }}</h4>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <template v-for="p in permissions" :key="`${p.kind}-${p.detail}`">
            <dt class="text-muted-foreground">{{ p.kind }}</dt>
            <dd class="text-foreground/80 break-words">
              {{ p.title }}
              <span class="font-mono text-muted-foreground">{{ p.detail }}</span>
              <span v-if="p.note" class="text-2xs uppercase tracking-caps text-muted-foreground">{{ p.note }}</span>
            </dd>
          </template>
        </dl>
      </section>

      <p class="text-2xs text-muted-foreground font-mono break-all">{{ app.image }}</p>
    </Card>
  </div>
</template>
