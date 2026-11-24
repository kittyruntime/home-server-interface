<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { PauseIcon, PlayIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { livePaused } from '../../lib/live-pause'

const { t } = useI18n()
</script>

<template>
  <Button variant="outline" size="sm" :aria-pressed="livePaused" @click="livePaused = !livePaused">
    <component :is="livePaused ? PlayIcon : PauseIcon" class="size-4" aria-hidden="true" />
    {{ livePaused ? t('monitor.live.resume') : t('monitor.live.pause') }}
  </Button>
</template>
