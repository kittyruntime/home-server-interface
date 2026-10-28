<script setup lang="ts">
import LoadingState from '../ui/LoadingState.vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// The page of one storage object (#40): a header with the object's name, its
// chips, its key figure and its actions, then Overview / Structure / Activity.

export type ObjectTab = 'overview' | 'structure' | 'activity'

defineProps<{
  title: string
  subtitle?: string
  loading: boolean
  error?: string
  /** The object is not there any more: what to say, and where to go back. */
  gone?: { text: string; back: string }
}>()
const emit = defineEmits<{ back: [] }>()
const tab = defineModel<ObjectTab>('tab', { default: 'overview' })

const TABS: { id: ObjectTab; label: string }[] = [
  { id: 'overview',  label: 'Overview' },
  { id: 'structure', label: 'Structure' },
  { id: 'activity',  label: 'Activity' },
]
</script>

<template>
  <div>
    <LoadingState v-if="loading" />
    <p v-else-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div v-else-if="gone" class="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-foreground/80">
      {{ gone.text }}
      <Button variant="link" class="ml-1 h-auto p-0 text-foreground underline" @click="emit('back')">{{ gone.back }}</Button>
    </div>

    <template v-else>
      <header class="flex flex-col @2xl/content:flex-row @2xl/content:items-start @2xl/content:justify-between gap-3 mb-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-lg font-semibold text-foreground truncate">{{ title }}</h2>
            <slot name="chips" />
          </div>
          <p v-if="subtitle" class="mt-0.5 font-mono text-xs text-muted-foreground truncate">{{ subtitle }}</p>
          <div class="mt-3"><slot name="figure" /></div>
        </div>
        <div class="flex items-center gap-2 shrink-0"><slot name="actions" /></div>
      </header>

      <Tabs v-model="tab">
        <TabsList aria-label="Sections of this page" class="mb-4">
          <TabsTrigger v-for="t in TABS" :key="t.id" :value="t.id">{{ t.label }}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><slot name="overview" /></TabsContent>
        <TabsContent value="structure"><slot name="structure" /></TabsContent>
        <TabsContent value="activity"><slot name="activity" /></TabsContent>
      </Tabs>
    </template>
  </div>
</template>
