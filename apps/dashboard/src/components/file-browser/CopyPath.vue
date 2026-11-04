<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckIcon, CopyIcon } from '@lucide/vue'
import { copyText } from '../../lib/copy-text'
import { useToast } from '../../lib/toast'

// A path that copies itself when clicked (#197): the properties header and
// the current folder in the breadcrumb. The slot is what is shown; `path` is
// what is copied.
const props = defineProps<{ path: string }>()
const { t } = useI18n()
const toast = useToast()
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  if (await copyText(props.path)) {
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => { copied.value = false }, 1200)
    toast.success(t('files.copyPath.copied'))
  } else {
    toast.error(t('files.copyPath.failed'))
  }
}
</script>

<template>
  <button
    type="button"
    :aria-label="t('files.copyPath.label', { path })"
    :title="t('files.copyPath.hint')"
    class="group/copy inline-flex min-w-0 max-w-full cursor-copy items-center gap-1 rounded-field text-left outline-none hover:text-base-content focus-visible:ring-2 focus-visible:ring-base-content/30"
    @click.stop="copy"
  >
    <span class="min-w-0 truncate"><slot>{{ path }}</slot></span>
    <CheckIcon v-if="copied" class="size-3 shrink-0 text-success" aria-hidden="true" />
    <CopyIcon v-else class="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-60 group-focus-visible/copy:opacity-60" aria-hidden="true" />
  </button>
</template>
