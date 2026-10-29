<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { onMounted, onUnmounted, ref } from 'vue'
import { trpc } from '../lib/trpc'
import { poller, pollDelay } from '../lib/backup'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import EmptyState from './ui/EmptyState.vue'
import PlanCard from './data-backup/PlanCard.vue'
import PlanForm from './data-backup/PlanForm.vue'
import RepositoryCard from './data-backup/RepositoryCard.vue'
import RepositoryForm from './data-backup/RepositoryForm.vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

// Data backups (#15): sync plans (rsync mirrors) and versioned plans (restic
// snapshots in a repository). The worker holds the state; every change goes
// through a reviewed plan.

type Status = Awaited<ReturnType<typeof trpc.backup.status.query>>
type Plan = Status['plans'][number]
type Repository = Status['repositories'][number]

const status = ref<Status | null>(null)
const loading = ref(true)
const loadError = ref('')
// 'new' while creating, the item while editing, null otherwise.
const planEdit = ref<Plan | 'new' | null>(null)
const repoEdit = ref<Repository | 'new' | null>(null)

async function fetchStatus() {
  try {
    status.value = await trpc.backup.status.query()
    loadError.value = ''
  } catch (e) {
    // A failed background refresh keeps the last status on screen.
    if (!status.value) loadError.value = e instanceof Error && e.message ? e.message : 'Failed to load the backups'
  } finally {
    loading.value = false
  }
}

const polling = poller(fetchStatus, () => pollDelay(status.value?.plans ?? []))
const load = () => polling.now()

// Former rsync plans the migration could not convert, listed until dismissed.
const dismissing = ref(false)
const dismissError = ref('')
async function dismissSkipped() {
  dismissing.value = true
  dismissError.value = ''
  try {
    await trpc.backup.dismissMigration.mutate()
    await load()
  } catch (e) {
    dismissError.value = e instanceof Error && e.message ? e.message : 'Failed to dismiss'
  } finally {
    dismissing.value = false
  }
}

function retry() {
  loading.value = true
  loadError.value = ''
  void load()
}

function planSaved() {
  planEdit.value = null
  void load()
}

function repoSaved() {
  repoEdit.value = null
  void load()
}

onMounted(load)
onUnmounted(() => polling.stop())
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">{{ t('ui.settings.DataBackupSection.dataBackups') }}</h2>
    <p class="text-sm text-muted-foreground mb-6">{{ t('ui.settings.DataBackupSection.syncKeepsAMirrorA') }}</p>

    <LoadingState v-if="loading" variant="compact" />
    <ErrorState v-else-if="loadError" :message="loadError" :retry-label="t('ui.settings.DataBackupSection.retry')" compact @retry="retry" />

    <template v-else-if="status">
      <p v-if="!status.engine.installed" role="alert" class="mb-4 status-text text-warning">
        <span class="status-tag">[WARN]</span> {{ t('ui.settings.DataBackupSection.theBackupEngineIsNot') }}
      </p>

      <Card v-if="status.migrationSkipped?.length" role="alert" class="block gap-0 py-0 overflow-hidden mb-4 p-4 space-y-2">
        <p class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ t('ui.settings.DataBackupSection.theseFormerBackupPlansCould') }}</p>
        <ul class="text-xs text-foreground/80 space-y-1">
          <li v-for="s in status.migrationSkipped ?? []" :key="s.name" class="break-words"><span class="font-medium text-foreground">{{ s.name || 'Unnamed plan' }}</span>: {{ s.error }}</li>
        </ul>
        <p v-if="dismissError" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ dismissError }}</p>
        <Button variant="ghost" size="xs" :disabled="dismissing" @click="dismissSkipped">{{ t('ui.settings.DataBackupSection.dismiss') }}</Button>
      </Card>

      <!-- Plans -->
      <section class="mb-6">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="eyebrow">{{ t('ui.settings.DataBackupSection.plans') }}</div>
          <Button size="xs" v-if="!planEdit" @click="planEdit = 'new'">{{ t('ui.settings.DataBackupSection.newPlan') }}</Button>
        </div>
        <PlanForm
          v-if="planEdit"
          :key="planEdit === 'new' ? 'new' : planEdit.id"
          :plan="planEdit === 'new' ? null : planEdit"
          :repositories="status.repositories"
          class="mb-3"
          @saved="planSaved"
          @cancel="planEdit = null"
        />
        <Card v-if="!status.plans.length && !planEdit" class="block gap-0 py-0 overflow-hidden">
          <EmptyState :message="t('ui.settings.DataBackupSection.noBackupPlanYet')" :description="t('ui.settings.DataBackupSection.aPlanCopiesFoldersOn')" />
        </Card>
        <div v-else class="space-y-3">
          <PlanCard
            v-for="p in status.plans"
            :key="p.id"
            :plan="p"
            :repositories="status.repositories"
            @edit="planEdit = p"
            @changed="load"
          />
        </div>
      </section>

      <!-- Repositories -->
      <section>
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="eyebrow">{{ t('ui.settings.DataBackupSection.repositories') }}</div>
          <Button variant="outline" size="xs" v-if="!repoEdit" @click="repoEdit = 'new'">{{ t('ui.settings.DataBackupSection.addRepository') }}</Button>
        </div>
        <p class="mb-3 text-xs text-muted-foreground">{{ t('ui.settings.DataBackupSection.aRepositoryStoresTheEncrypted') }}</p>
        <RepositoryForm
          v-if="repoEdit"
          :key="repoEdit === 'new' ? 'new' : repoEdit.id"
          :repository="repoEdit === 'new' ? null : repoEdit"
          class="mb-3"
          @saved="repoSaved"
          @cancel="repoEdit = null"
        />
        <Card v-if="!status.repositories.length && !repoEdit" class="block gap-0 py-0 overflow-hidden">
          <EmptyState :message="t('ui.settings.DataBackupSection.noRepositoryYet')" :description="t('ui.settings.DataBackupSection.addOneBeforeCreatingA')" />
        </Card>
        <div v-else class="space-y-3">
          <RepositoryCard
            v-for="r in status.repositories"
            :key="r.id"
            :repository="r"
            :plans="status.plans"
            @edit="repoEdit = r"
            @changed="load"
          />
        </div>
      </section>
    </template>
  </div>
</template>
