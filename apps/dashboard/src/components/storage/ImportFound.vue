<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { applyPlanned } from '../../lib/plan'
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { useConfirm } from '../../lib/confirm'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

/* Existing storage found on the disks but not in use yet (after a reinstall,
   or disks moved from another machine). Import never formats anything: arrays
   are assembled from their own superblocks, volume groups are activated. The
   filesystems they hold then appear in Mounts, ready to be mounted. */
defineProps<{ kind: 'raid' | 'lvm' }>()
const emit = defineEmits<{ imported: [] }>()

type Scan = Awaited<ReturnType<typeof trpc.storage.importScan.query>>
const scan = ref<Scan | null>(null)
const busy = ref<string | null>(null)
const toast = useToast()
const { confirm } = useConfirm()

async function load() {
  try { scan.value = await trpc.storage.importScan.query() } catch { scan.value = null }
}
onMounted(load)

async function assemble(a: Scan['arrays'][number]) {
  const degraded = a.missing > 0
  if (degraded && !await confirm(
    t('uis.storage.ImportFound.ofMembersOfThisArray', { p0: a.missing, p1: a.expected }),
    { danger: true, confirmLabel: t('uis.storage.ImportFound.startDegraded') },
  )) return
  busy.value = a.uuid
  try {
    // The server picks the name: it knows the names mdadm.conf keeps.
    const res = await applyPlanned('import.assemble', { uuid: a.uuid, allowDegraded: degraded },
      { title: t('uis.storage.ImportFound.assembleTheExistingArray', { p0: a.name || a.device }), actionLabel: degraded ? 'Start degraded' : 'Assemble' })
    for (const w of res.warnings ?? []) toast.error(w)
    toast.success(t('uis.storage.ImportFound.arrayAssembledAs', { p0: res.device }))
    emit('imported')
    await load()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('uis.storage.ImportFound.couldNotAssembleTheArray'))
  } finally {
    busy.value = null
  }
}

async function activate(vg: Scan['vgs'][number]) {
  busy.value = vg.name
  try {
    await applyPlanned('import.activate', { name: vg.name },
      { title: t('uis.storage.ImportFound.activateTheVolumeGroup', { p0: vg.name }), actionLabel: t('uis.storage.ImportFound.activate') })
    toast.success(t('uis.storage.ImportFound.volumeGroupActivated', { p0: vg.name }))
    emit('imported')
    await load()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('uis.storage.ImportFound.couldNotActivateTheVolume'))
  } finally {
    busy.value = null
  }
}

defineExpose({ load })
</script>

<template>
  <Alert variant="info" v-if="kind === 'raid' && scan?.arrays.length" class="block mb-5 p-4" role="note">
    <h3 class="text-sm font-semibold text-foreground">{{ t('ui.storage.ImportFound.arraysFoundOnDisks') }}</h3>
    <p class="text-xs text-muted-foreground mt-0.5 mb-3">{{ t('ui.storage.ImportFound.theseArraysExistOnThe') }}</p>
    <div v-for="a in scan.arrays" :key="a.uuid" class="flex flex-wrap items-center gap-3 py-2 border-t border-border first:border-t-0">
      <div class="min-w-0 flex-1">
        <div class="text-sm text-foreground">
          <span class="font-mono">{{ a.name || a.device }}</span>
          <span class="text-xs text-muted-foreground ml-2 uppercase">{{ a.level }}</span>
        </div>
        <div class="text-2xs text-muted-foreground font-mono break-all">{{ a.members.join(' + ') }}</div>
        <div v-if="a.missing > 0" class="text-2xs text-warning">{{ t('uip.storage.ImportFound.ofMembersNotFound', { p0: a.missing, p1: a.expected }) }}</div>
        <div v-if="a.extra > 0" class="text-2xs text-destructive">
          {{ t('uip.storage.ImportFound.disksCarryThisArrayWhich', { p0: a.members.length, p1: a.expected + a.spares }) }}
        </div>
      </div>
      <Button size="xs" v-if="!(a.extra > 0)" type="button" :disabled="busy !== null" @click="assemble(a)">
        {{ busy === a.uuid ? 'Assembling…' : a.missing > 0 ? 'Start degraded…' : 'Assemble' }}
      </Button>
    </div>
  </Alert>

  <Alert variant="info" v-if="kind === 'lvm' && scan?.vgs.length" class="block mb-5 p-4" role="note">
    <h3 class="text-sm font-semibold text-foreground">{{ t('ui.storage.ImportFound.inactiveVolumeGroups') }}</h3>
    <p class="text-xs text-muted-foreground mt-0.5 mb-3">{{ t('ui.storage.ImportFound.theseVolumeGroupsExistOn') }}</p>
    <div v-for="vg in scan.vgs" :key="vg.name" class="flex flex-wrap items-center gap-3 py-2 border-t border-border first:border-t-0">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-mono text-foreground">{{ vg.name }}</div>
        <div class="text-2xs text-muted-foreground font-mono break-all">{{ vg.lvs.join(', ') }}</div>
      </div>
      <Button size="xs" type="button" :disabled="busy !== null" @click="activate(vg)">
        {{ busy === vg.name ? 'Activating…' : 'Activate' }}
      </Button>
    </div>
  </Alert>
</template>
