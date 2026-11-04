<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MAX_LABEL, bookmarkLabel, type Bookmark } from '../../lib/bookmarks'

// Renames a bookmark (#199): only its label, never the folder. An empty
// label goes back to the folder's name.
const props = defineProps<{ bookmark: Bookmark }>()
const emit = defineEmits<{ save: [label: string]; close: [] }>()
const { t } = useI18n()
const label = ref(props.bookmark.label ?? '')
</script>

<template>
  <Modal panel-class="w-full max-w-sm" @close="emit('close')">
    <template #header>
      <h2 class="text-sm font-semibold">{{ t('files.bookmarks.renameTitle') }}</h2>
    </template>
    <form id="rename-bookmark" class="space-y-2 p-5" @submit.prevent="emit('save', label)">
      <label for="bookmark-label" class="text-xs font-medium text-base-content/70">{{ t('files.bookmarks.label') }}</label>
      <Input id="bookmark-label" v-model="label" :maxlength="MAX_LABEL" :placeholder="bookmarkLabel({ path: bookmark.path })" autofocus />
      <p class="truncate font-mono text-xs text-base-content/70">{{ bookmark.path }}</p>
    </form>
    <template #footer>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" @click="emit('close')">{{ t('files.bookmarks.cancel') }}</Button>
      <Button size="sm" type="submit" form="rename-bookmark">{{ t('files.bookmarks.save') }}</Button>
    </template>
  </Modal>
</template>
