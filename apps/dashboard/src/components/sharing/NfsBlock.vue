<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MonitorIcon } from '@lucide/vue'
import AddressList from './AddressList.vue'
import { nfsAddresses } from '../../lib/share-address'
import { shareHost } from '../../lib/sharing-types'

const props = defineProps<{
  share: string
  path: string
  /** Allowed client addresses or networks, as stored (space-separated). */
  clients: string
  /** The account new files belong to; "" when the export is read-only. */
  writeAs: string
  /** Machines with it mounted now. */
  connected: string[]
  /** The server's local address; the browser's host otherwise. */
  host?: string
}>()
const { t } = useI18n()

const items = computed(() => nfsAddresses({ host: shareHost(props.host), path: props.path, share: props.share })
  .map(a => ({ key: `nfs-${a.os}`, label: t(`sharing.detail.${a.os}`), address: a.address })))
const allowed = computed(() => props.clients.split(' ').filter(Boolean))
</script>

<template>
  <section class="space-y-2">
    <h4 class="eyebrow">{{ t('sharing.nfs.title') }}</h4>
    <AddressList :items="items" />
    <p class="text-xs text-base-content/80">
      {{ t('sharing.nfs.allowed') }}
      <template v-for="(c, i) in allowed" :key="c"><span class="font-mono">{{ c }}</span><template v-if="i < allowed.length - 1">, </template></template>.
      {{ writeAs ? t('sharing.nfs.writesAs', { user: writeAs }) : t('sharing.nfs.readOnly') }}
    </p>
    <ul v-if="connected.length" class="space-y-1 pt-1">
      <li v-for="ip in connected" :key="ip" class="flex items-center gap-2 text-sm">
        <MonitorIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
        <span class="font-mono text-xs">{{ ip }}</span>
        <span class="text-xs text-base-content/70">{{ t('sharing.nfs.mounted') }}</span>
      </li>
    </ul>
  </section>
</template>
