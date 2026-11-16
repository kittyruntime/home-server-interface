<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckIcon, CopyIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { shareAddresses } from '../../lib/share-address'
import { copyText } from '../../lib/copy-text'
import { useToast } from '../../lib/toast'

const props = defineProps<{
  share: string
  guestOk: boolean
  /** The viewer's own username; absent in the admin view. */
  username?: string
  netbiosName?: string
  wsd?: boolean
  mdns?: boolean
}>()

const { t } = useI18n()
const toast = useToast()

const addresses = computed(() => shareAddresses({
  host: window.location.hostname, share: props.share,
  netbiosName: props.netbiosName, wsd: props.wsd, mdns: props.mdns,
}))

// The copied row shows a check for a moment, where the click happened.
const copied = ref<string | null>(null)
let reset: ReturnType<typeof setTimeout> | null = null
onUnmounted(() => { if (reset) clearTimeout(reset) })

async function copy(os: string, address: string) {
  if (!await copyText(address)) {
    toast.error(t('sharing.detail.copyFailed'))
    return
  }
  copied.value = os
  if (reset) clearTimeout(reset)
  reset = setTimeout(() => { copied.value = null }, 1600)
}
</script>

<template>
  <section class="space-y-2">
    <h4 class="eyebrow">{{ t('sharing.detail.connect') }}</h4>
    <span class="sr-only" aria-live="polite">{{ copied ? t('sharing.detail.copied') : '' }}</span>
    <ul class="space-y-1.5">
      <li v-for="a in addresses" :key="a.os" class="flex items-center gap-2 min-w-0">
        <span class="w-16 shrink-0 text-xs text-base-content/70">{{ t(`sharing.detail.${a.os}`) }}</span>
        <code class="min-w-0 flex-1 truncate rounded-field bg-base-200 px-2 py-1 font-mono text-xs text-base-content select-all" :title="a.address">{{ a.address }}</code>
        <Button variant="ghost" size="xs" class="shrink-0" :aria-label="copied === a.os ? t('sharing.detail.copied') : t('sharing.detail.copyWhat', { os: t(`sharing.detail.${a.os}`) })" @click="copy(a.os, a.address)">
          <CheckIcon v-if="copied === a.os" class="size-3.5 text-success" />
          <CopyIcon v-else class="size-3.5" />
        </Button>
      </li>
    </ul>
    <p class="text-xs text-base-content/80">
      <template v-if="guestOk">{{ t('sharing.detail.guestCredentials') }} </template>
      {{ username ? t('sharing.detail.credentials', { user: username }) : t('sharing.detail.credentialsAny') }}
    </p>
  </section>
</template>
