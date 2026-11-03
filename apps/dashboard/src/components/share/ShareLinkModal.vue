<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Checkbox } from '@/components/ui/checkbox'
import { ref } from 'vue'
import { trpc } from '../../lib/trpc'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()
const props = defineProps<{ path: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

const usePassword = ref(false)
const password = ref('')
const expiresInDays = ref<number | null>(7)
const useLimit = ref(false)
const maxDownloads = ref(1)
const busy = ref(false)
const error = ref('')
const url = ref('')
const copied = ref(false)

async function create() {
  busy.value = true; error.value = ''
  try {
    const r = await trpc.shareLink.create.mutate({
      path: props.path,
      password: usePassword.value && password.value ? password.value : undefined,
      expiresInDays: expiresInDays.value ?? undefined,
      maxDownloads: useLimit.value ? maxDownloads.value : undefined,
    })
    url.value = `${window.location.origin}/s/${r.token}`
  } catch (e: unknown) {
    const err = e as { message?: string; data?: { code?: string } }
    error.value = err?.data?.code === 'FORBIDDEN'
      ? t('uis.sharing.ShareLinkModal.noPermission')
      : (err?.message ?? t('uis.sharing.ShareLinkModal.failedToCreate'))
  } finally { busy.value = false }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true; setTimeout(() => (copied.value = false), 1500)
  } catch { /* clipboard unavailable (non-secure context); the URL stays selectable in the field */ }
}
</script>

<template>
  <Modal :label="t('uip.sharing.ShareLinkModal.share', { p0: name })" panel-class="w-full max-w-md" :show-close="false" @close="emit('close')">
    <div class="p-6 space-y-4">
      <h3 class="text-base font-semibold text-base-content">{{ t('uip.sharing.ShareLinkModal.share', { p0: name }) }}</h3>

      <template v-if="!url">
        <label class="flex items-center gap-2 text-sm text-base-content/80">
          <Checkbox v-model="usePassword" /> {{ t('ui.sharing.ShareLinkModal.passwordProtect') }}
        </label>
        <Input v-if="usePassword" v-model="password" type="password" :placeholder="t('ui.sharing.ShareLinkModal.password')" />

        <div>
          <label class="block text-xs text-base-content/80 mb-1">{{ t('ui.sharing.ShareLinkModal.expires') }}</label>
          <NativeSelect v-model.number="expiresInDays">
            <NativeSelectOption :value="1">{{ t('ui.sharing.ShareLinkModal.hours24') }}</NativeSelectOption>
            <NativeSelectOption :value="7">{{ t('ui.sharing.ShareLinkModal.days7') }}</NativeSelectOption>
            <NativeSelectOption :value="30">{{ t('ui.sharing.ShareLinkModal.days30') }}</NativeSelectOption>
            <NativeSelectOption :value="null">{{ t('ui.sharing.ShareLinkModal.never') }}</NativeSelectOption>
          </NativeSelect>
        </div>

        <label class="flex items-center gap-2 text-sm text-base-content/80">
          <Checkbox v-model="useLimit" /> {{ t('ui.sharing.ShareLinkModal.limitDownloads') }}
        </label>
        <Input v-if="useLimit" v-model.number="maxDownloads" type="number" min="1" />

        <p v-if="error" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ error }}</p>
        <div class="flex gap-2 pt-1">
          <Button size="sm" @click="create" :disabled="busy">
            {{ busy ? t('ui.sharing.ShareLinkModal.creating') : t('ui.sharing.ShareLinkModal.createLink') }}
          </Button>
          <Button variant="ghost" size="sm" @click="emit('close')">{{ t('ui.sharing.ShareLinkModal.cancel') }}</Button>
        </div>
      </template>

      <template v-else>
        <p class="text-xs text-base-content/70">{{ t('ui.sharing.ShareLinkModal.anyoneWithLink') }}</p>
        <div class="flex gap-2">
          <Input :model-value="url" readonly class="font-mono text-xs" />
          <Button variant="outline" size="sm" @click="copy" class="shrink-0">{{ copied ? t('ui.sharing.ShareLinkModal.copied') : t('ui.sharing.ShareLinkModal.copy') }}</Button>
        </div>
        <Button variant="ghost" size="sm" @click="emit('close')">{{ t('ui.sharing.ShareLinkModal.done') }}</Button>
      </template>
    </div>
  </Modal>
</template>
