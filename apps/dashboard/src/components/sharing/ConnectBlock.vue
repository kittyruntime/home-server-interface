<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AddressList from './AddressList.vue'
import { shareAddresses } from '../../lib/share-address'
import { shareHost } from '../../lib/sharing-types'

const props = defineProps<{
  share: string
  guestOk: boolean
  /** The viewer's own username; absent in the admin view. */
  username?: string
  netbiosName?: string
  wsd?: boolean
  mdns?: boolean
  /** The server's local address; the browser's host otherwise. */
  host?: string
  /** A heading naming the protocol, when the share has several. */
  title?: string
}>()

const { t } = useI18n()

const items = computed(() => shareAddresses({
  host: shareHost(props.host), share: props.share,
  netbiosName: props.netbiosName, wsd: props.wsd, mdns: props.mdns,
}).map(a => ({ key: a.os, label: t(`sharing.detail.${a.os}`), address: a.address })))
</script>

<template>
  <section class="space-y-2">
    <h4 class="eyebrow">{{ title ?? t('sharing.detail.connect') }}</h4>
    <AddressList :items="items" />
    <p class="text-xs text-base-content/80">
      <template v-if="guestOk">{{ t('sharing.detail.guestCredentials') }} </template>
      {{ username ? t('sharing.detail.credentials', { user: username }) : t('sharing.detail.credentialsAny') }}
    </p>
  </section>
</template>
