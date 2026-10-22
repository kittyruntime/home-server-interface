<script setup lang="ts">
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
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Data backups</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">Sync keeps a mirror: a deletion is copied too. Versions keep history: you can go back to an earlier date.</p>

    <LoadingState v-if="loading" variant="compact" />
    <ErrorState v-else-if="loadError" :message="loadError" retry-label="Retry" compact @retry="retry" />

    <template v-else-if="status">
      <p v-if="!status.engine.installed" role="alert" class="mb-4 status-text text-warning">
        <span class="status-tag">[WARN]</span> The backup engine is not installed. Run the installer again to enable versioned backups.
      </p>

      <div v-if="status.migrationSkipped?.length" role="alert" class="mb-4 panel-card p-4 bg-[var(--c-surface)] space-y-2">
        <p class="status-text text-warning"><span class="status-tag">[WARN]</span> These former backup plans could not be moved to the new backups. Create them again below.</p>
        <ul class="text-xs text-[var(--c-text-2)] space-y-1">
          <li v-for="s in status.migrationSkipped ?? []" :key="s.name" class="break-words"><span class="font-medium text-[var(--c-text-1)]">{{ s.name || 'Unnamed plan' }}</span>: {{ s.error }}</li>
        </ul>
        <p v-if="dismissError" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ dismissError }}</p>
        <button class="btn btn-ghost btn-xs" :disabled="dismissing" @click="dismissSkipped">Dismiss</button>
      </div>

      <!-- Plans -->
      <section class="mb-6">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="eyebrow">Plans</div>
          <button v-if="!planEdit" class="btn btn-primary btn-xs" @click="planEdit = 'new'">New plan…</button>
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
        <div v-if="!status.plans.length && !planEdit" class="panel-card bg-[var(--c-surface)]">
          <EmptyState message="No backup plan yet." description="A plan copies folders on a schedule, as a mirror or as versions." />
        </div>
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
          <div class="eyebrow">Repositories</div>
          <button v-if="!repoEdit" class="btn btn-outline btn-xs" @click="repoEdit = 'new'">Add repository…</button>
        </div>
        <p class="mb-3 text-xs text-[var(--c-text-3)]">A repository stores the encrypted versions of one or more plans: a disk, an SFTP server, an S3 bucket or a REST server.</p>
        <RepositoryForm
          v-if="repoEdit"
          :key="repoEdit === 'new' ? 'new' : repoEdit.id"
          :repository="repoEdit === 'new' ? null : repoEdit"
          class="mb-3"
          @saved="repoSaved"
          @cancel="repoEdit = null"
        />
        <div v-if="!status.repositories.length && !repoEdit" class="panel-card bg-[var(--c-surface)]">
          <EmptyState message="No repository yet." description="Add one before creating a versions plan." />
        </div>
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
