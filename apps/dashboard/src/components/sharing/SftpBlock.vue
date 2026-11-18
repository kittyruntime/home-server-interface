<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MonitorIcon } from '@lucide/vue'
import AddressList from './AddressList.vue'
import { sftpAddress } from '../../lib/share-address'
import { shareHost } from '../../lib/sharing-types'

const props = defineProps<{
  share: string
  /** The account shown in the address: the viewer's own. */
  user: string
  port: number
  host?: string
  /** Admin view: accounts that get no SFTP view, and who is connected now. */
  leftOut?: string[]
  sessions?: string[]
}>()
const { t } = useI18n()

const items = computed(() => [{
  key: 'sftp', label: 'SFTP',
  address: sftpAddress({ host: shareHost(props.host), port: props.port, user: props.user, share: props.share }),
}])
</script>

<template>
  <section class="space-y-2">
    <h4 class="eyebrow">{{ t('sharing.sftp.title') }}</h4>
    <AddressList :items="items" />
    <p class="text-xs text-base-content/80">{{ t('sharing.sftp.credentials') }}</p>
    <p v-if="leftOut?.length" class="text-xs text-warning">{{ t('sharing.sftp.leftOut', { users: leftOut.join(', ') }, leftOut.length) }}</p>
    <ul v-if="sessions?.length" class="space-y-1 pt-1">
      <li v-for="u in sessions" :key="u" class="flex items-center gap-2 text-sm">
        <MonitorIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
        <span class="font-medium">{{ u }}</span>
        <span class="text-xs text-base-content/70">{{ t('sharing.sftp.connected') }}</span>
      </li>
    </ul>
  </section>
</template>
