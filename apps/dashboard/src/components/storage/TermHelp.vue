<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Hint from '@/components/ui/Hint.vue'
import { TERM_ANCHORS, guideUrl, type TermId } from '../../lib/storage-docs'

// A storage term explained in one line, with a link to its glossary entry.
const props = defineProps<{ term: TermId }>()
const { t } = useI18n()
</script>

<template>
  <Hint :text="t(`ui.storage.terms.${props.term}`)" :href="guideUrl('glossary', TERM_ANCHORS[props.term])" :link-text="t('ui.storage.terms.readMore')" />
</template>
