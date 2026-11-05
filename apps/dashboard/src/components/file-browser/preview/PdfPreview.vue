<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, onMounted } from 'vue'
import { DownloadIcon, ExternalLinkIcon, FileTextIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { downloadUrl, previewUrl } from '../../../lib/file-url'

const { t } = useI18n()

const props = defineProps<{ path: string; name: string }>()

// A phone's browser has no PDF viewer to embed (Android only offers to
// download it): there the preview is a page with the browser's own ways to
// open it. A computer shows the PDF in place, with the same way out.
const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches

const url = ref<string | null>(null)
const download = ref<string | null>(null)
const failed = ref(false)

onMounted(async () => {
  try {
    ;[url.value, download.value] = await Promise.all([previewUrl(props.path), downloadUrl(props.path)])
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <div class="h-full flex flex-col min-h-0 bg-base-200">
    <div v-if="failed" class="flex-1 flex items-center justify-center text-center text-base-content/70 text-sm">
      <p>{{ t('ui.files.MediaPreview.couldnTLoadThisFile') }}</p>
    </div>

    <template v-else>
      <iframe
        v-if="!coarse && url"
        :src="url"
        :title="name"
        class="flex-1 min-h-0 w-full border-0 bg-base-100"
      />
      <div v-else-if="coarse" class="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <FileTextIcon class="size-12 text-base-content/50" aria-hidden="true" />
        <p class="text-sm font-medium text-base-content break-all">{{ name }}</p>
      </div>
      <div v-else class="flex-1" />

      <div class="flex flex-wrap items-center justify-center gap-2 p-3 border-t border-base-300 bg-base-100">
        <Button as="a" :href="url ?? undefined" target="_blank" rel="noopener" :disabled="!url" :size="coarse ? 'default' : 'sm'" :class="coarse ? 'w-full sm:w-auto' : ''">
          <ExternalLinkIcon aria-hidden="true" /> {{ t('ui.files.PdfPreview.openInNewTab') }}
        </Button>
        <Button as="a" variant="ghost" :href="download ?? undefined" :download="name" :disabled="!download" :size="coarse ? 'default' : 'sm'" :class="coarse ? 'w-full sm:w-auto' : ''">
          <DownloadIcon aria-hidden="true" /> {{ t('ui.files.PdfPreview.download') }}
        </Button>
      </div>
    </template>
  </div>
</template>
