<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { applyPlanned } from '../../../lib/plan'
import { ref } from 'vue'
import { trpc } from '../../../lib/trpc'
import { fmtBytes, type BlockDev } from '../store'
import Modal from '../../ui/Modal.vue'
import { useToast } from '../../../lib/toast'
import { useAuth } from '../../../lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()

/* Shared mount dialog. Call open(dev) via a template ref; emits `done` after a
   successful mount. */
const emit = defineEmits<{ done: [] }>()
const toast = useToast()
// Places are admin-managed; storage-only users just mount.
const { isAdmin } = useAuth()

// HSI accounts a volume can be given to. HSI groups are not Linux groups, so
// group access goes through the Place instead.
const users = ref<{ id: string; username: string; displayName: string | null }[]>([])

const dlg = ref<{
  dev:     BlockDev
  mp:      string
  options: string
  persist: boolean
  access:  'shared' | 'user' | 'keep'
  ownerUserId: string
  force:   boolean
  createPlace: boolean
  placeName:   string
  busy:    boolean
  err:     string
} | null>(null)

function open(dev: BlockDev) {
  dlg.value = { dev, mp: `/mnt/${dev.name}`, options: 'defaults', persist: true, access: 'shared',
    ownerUserId: '', force: false, createPlace: isAdmin.value, placeName: dev.name, busy: false, err: '' }
  trpc.user.list.query()
    .then(list => { users.value = list })
    .catch(() => { users.value = [] })
}

async function doMount() {
  if (!dlg.value) return
  const d = dlg.value
  d.busy = true
  d.err  = ''
  try {
    const device = d.dev.path.replace(/^\/dev\//, '')
    const res = await applyPlanned('mount', {
      device, mountpoint: d.mp, options: d.options || undefined, persist: d.persist, access: d.access,
      ownerUserId: d.access === 'user' ? d.ownerUserId : undefined,
      force: d.access !== 'keep' && d.force,
    }, { title: t('uis.storage.DeviceMountDialog.mountOn', { p0: d.dev.path, p1: d.mp }), actionLabel: t('uis.storage.DeviceMountDialog.mount') })
    // Mounted: anything left unchanged (existing data, unknown account) is
    // reported without failing the mount.
    for (const w of res.warnings ?? []) toast.info(w)
    // A Place makes the volume visible in Files and lets permissions be
    // granted per user/group. The mount itself already succeeded.
    if (d.createPlace && d.placeName.trim()) {
      try {
        await trpc.place.create.mutate({ name: d.placeName.trim(), path: d.mp })
        toast.success(t('uis.storage.DeviceMountDialog.placeCreated', { p0: d.placeName.trim() }))
      } catch (e: unknown) {
        toast.error(`Mounted, but the Place was not created: ${(e as { message?: string })?.message ?? t('uis.storage.DeviceMountDialog.unknownError')}`)
      }
    }
    dlg.value = null
    emit('done')
  } catch (e: unknown) {
    d.err = (e as { message?: string })?.message ?? t('uis.storage.DeviceMountDialog.mountFailed')
  } finally {
    if (dlg.value) d.busy = false
  }
}

defineExpose({ open })
</script>

<template>
  <Modal v-if="dlg" panel-class="w-full max-w-sm" :show-close="false" :prevent-close="!!dlg.busy" @close="dlg = null">
    <div class="px-5 py-4 border-b border-border">
      <h3 class="font-semibold text-foreground">{{ t('ui.storage.DeviceMountDialog.mountDevice') }}</h3>
      <p class="text-xs text-muted-foreground mt-0.5">
        <span class="font-mono">{{ dlg.dev.path }}</span>
        <span v-if="dlg.dev.fstype"> · {{ dlg.dev.fstype }}</span>
        · {{ fmtBytes(dlg.dev.size) }}
      </p>
    </div>
    <div class="p-5 space-y-4">
      <div>
        <label class="block text-xs font-medium text-foreground/80 mb-1.5">{{ t('ui.storage.DeviceMountDialog.mountPoint') }}</label>
        <Input
          v-model="dlg.mp"
          type="text"
          class="w-full px-3 py-2 text-sm font-mono"
        />
        <p class="text-2xs text-muted-foreground mt-1">{{ t('ui.storage.DeviceMountDialog.directoryWillBeCreatedIf') }}</p>
      </div>
      <div>
        <label class="block text-xs font-medium text-foreground/80 mb-1.5">{{ t('ui.storage.DeviceMountDialog.mountOptions') }}</label>
        <Input
          v-model="dlg.options"
          type="text"
          laceholder="defaults"
          class="w-full px-3 py-2 text-sm font-mono"
        />
      </div>
      <label class="flex items-start gap-2.5 cursor-pointer">
        <Checkbox v-model="dlg.persist" class="mt-0.5" />
        <div>
          <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceMountDialog.persistAcrossReboots') }}</div>
          <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceMountDialog.addAUuidBasedEntry') }}</div>
        </div>
      </label>
      <fieldset class="space-y-2">
        <legend class="text-xs font-medium text-foreground/80 mb-1.5">{{ t('ui.storage.DeviceMountDialog.access') }}</legend>
        <RadioGroup v-model="dlg.access" class="gap-2">
        <label class="flex items-start gap-2.5 cursor-pointer">
          <RadioGroupItem value="shared" class="mt-0.5" />
          <div>
            <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceMountDialog.writableByYouAndShared') }}</div>
            <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceMountDialog.onANewEmptyVolume') }}</div>
          </div>
        </label>
        <label class="flex items-start gap-2.5 cursor-pointer">
          <RadioGroupItem value="user" class="mt-0.5" />
          <div class="flex-1">
            <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceMountDialog.ownedByAnotherUser') }}</div>
            <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceMountDialog.sameAsAboveOwnedBy') }}</div>
            <NativeSelect wrapper-class="mt-1.5 w-full" v-if="dlg.access === 'user'" v-model="dlg.ownerUserId"
              class="px-3 py-2 text-sm">
              <NativeSelectOption value="" disabled>{{ t('ui.storage.DeviceMountDialog.chooseAUser') }}</NativeSelectOption>
              <NativeSelectOption v-for="u in users" :key="u.id" :value="u.id">
                {{ u.displayName ? `${u.displayName} (${u.username})` : u.username }}
              </NativeSelectOption>
            </NativeSelect>
          </div>
        </label>
        <label class="flex items-start gap-2.5 cursor-pointer">
          <RadioGroupItem value="keep" class="mt-0.5" />
          <div>
            <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceMountDialog.keepCurrentPermissions') }}</div>
            <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceMountDialog.aNewVolumeStaysOwned') }}</div>
          </div>
        </label>
        </RadioGroup>
        <label v-if="dlg.access !== 'keep'" class="flex items-start gap-2.5 cursor-pointer pt-1">
          <Checkbox v-model="dlg.force" class="mt-0.5" />
          <div>
            <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceMountDialog.alsoApplyIfTheVolume') }}</div>
            <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceMountDialog.changesTheOwnerAndMode') }}</div>
          </div>
        </label>
      </fieldset>
      <div v-if="isAdmin" class="space-y-2">
        <label class="flex items-start gap-2.5 cursor-pointer">
          <Checkbox v-model="dlg.createPlace" class="mt-0.5" />
          <div>
            <div class="text-xs font-medium text-foreground/80">{{ t('ui.storage.DeviceMountDialog.createAPlaceForThis') }}</div>
            <div class="text-2xs text-muted-foreground">{{ t('ui.storage.DeviceMountDialog.showsItInFilesAnd') }}</div>
          </div>
        </label>
        <Input v-if="dlg.createPlace" v-model="dlg.placeName" type="text" :placeholder="t('ui.storage.DeviceMountDialog.placeName')"
          class="w-full px-3 py-2 text-sm"/>
      </div>
      <p v-if="dlg.err" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ dlg.err }}</p>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" @click="dlg = null" class="flex-1 justify-center">{{ t('ui.storage.DeviceMountDialog.cancel') }}</Button>
        <Button @click="doMount" :disabled="!dlg.mp || dlg.busy || (dlg.access === 'user' && !dlg.ownerUserId)"
          class="flex-1 justify-center">
          <span v-if="dlg.busy">{{ t('ui.storage.DeviceMountDialog.mounting') }}</span>
          <span v-else>{{ t('ui.storage.DeviceMountDialog.mount') }}</span>
        </Button>
      </div>
    </div>
  </Modal>
</template>
