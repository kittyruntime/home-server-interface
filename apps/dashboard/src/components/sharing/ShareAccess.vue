<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ShareDetailData } from '../../lib/sharing-types'

defineProps<{ access: ShareDetailData['access'] }>()
const { t } = useI18n()
</script>

<template>
  <section class="space-y-2">
    <h4 class="eyebrow">{{ t('sharing.detail.access') }}</h4>
    <ul class="space-y-2">
      <li v-for="a in access" :key="a.username" class="text-sm">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span class="size-2 shrink-0 rounded-full" :class="a.networkPassword ? 'bg-success' : 'bg-warning'"
            :title="a.networkPassword ? t('sharing.detail.passwordOk') : t('sharing.detail.passwordMissing')" />
          <span class="font-medium text-base-content">{{ a.username }}</span>
          <span class="text-xs text-base-content/70">
            {{ a.level === 'write' ? t('sharing.detail.write') : t('sharing.detail.read') }}<template v-if="a.via === 'group'"> · {{ t('sharing.detail.viaGroup') }}</template><template v-else-if="a.via === 'admin'"> · {{ t('sharing.detail.viaAdmin') }}</template>
          </span>
        </div>
        <p v-if="!a.networkPassword" class="ml-4 mt-0.5 text-xs text-warning">{{ t('sharing.detail.passwordMissingHelp', { user: a.username }) }}</p>
      </li>
    </ul>
  </section>
</template>
