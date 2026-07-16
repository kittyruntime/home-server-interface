<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'

type Diag = Awaited<ReturnType<typeof trpc.sharing.diagnose.query>>
type ShareDiag = Diag['shares'][number]

const shares = ref<ShareDiag[]>([])
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await trpc.sharing.diagnose.query()
    shares.value = d.shares
  } catch (e: any) {
    error.value = e?.message ?? 'Échec du diagnostic'
  } finally {
    loading.value = false
  }
}
onMounted(load)

function dirWritable(s: ShareDiag): boolean {
  return !!s.dir?.exists && s.dir.groupWritable && s.dir.setgid
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold text-[var(--c-text-1)]">Diagnostic des partages</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">
          Qui peut réellement lire/écrire, qui est bloqué et pourquoi, et l'état des dossiers.
        </p>
      </div>
      <button class="btn btn-outline btn-sm shrink-0" :disabled="loading" @click="load">Rafraîchir</button>
    </div>

    <div v-if="loading" class="text-sm text-[var(--c-text-3)]">Analyse…</div>
    <div v-else-if="error" class="text-sm text-[var(--c-danger)]">{{ error }}</div>
    <div v-else-if="shares.length === 0" class="text-sm text-[var(--c-text-3)]">Aucun partage actif.</div>

    <div v-else class="space-y-3">
      <div v-for="s in shares" :key="s.id" class="panel-card p-4 space-y-3">
        <!-- Header -->
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <span class="text-sm font-medium text-[var(--c-text-1)]">{{ s.name }}</span>
            <span class="block text-xs text-[var(--c-text-3)] font-mono truncate">{{ s.path }}</span>
          </div>
          <span
            :class="['badge shrink-0', dirWritable(s) ? 'badge-muted' : '']"
            :style="!dirWritable(s) ? 'color: var(--c-warning); background: color-mix(in srgb, var(--c-warning) 16%, transparent)' : ''"
          >{{ dirWritable(s) ? 'Dossier OK' : 'Dossier non inscriptible' }}</span>
        </div>

        <!-- Nobody can write -->
        <p v-if="s.writers.length === 0 && !s.readOnly" class="text-xs text-[var(--c-warning)]">
          ⚠ Aucun compte ne peut écrire dans ce partage.
        </p>

        <!-- Writers -->
        <div v-if="s.writers.length" class="space-y-1">
          <div class="eyebrow">Écriture</div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="w in s.writers" :key="w.linuxUsername"
              class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-[var(--c-surface-alt)] border border-[var(--c-border)]">
              <span class="w-1.5 h-1.5 rounded-full" :class="w.hasSamba ? 'bg-[var(--c-success)]' : 'bg-[var(--c-danger)]'" />
              {{ w.linuxUsername }}
              <span v-if="!w.hasSamba" class="text-[var(--c-danger)]">· pas de mot de passe Samba</span>
            </span>
          </div>
        </div>

        <!-- Readers -->
        <div v-if="s.readers.length" class="space-y-1">
          <div class="eyebrow">Lecture seule</div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="r in s.readers" :key="r.linuxUsername"
              class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-[var(--c-surface-alt)] border border-[var(--c-border)] text-[var(--c-text-2)]">
              <span class="w-1.5 h-1.5 rounded-full" :class="r.hasSamba ? 'bg-[var(--c-success)]' : 'bg-[var(--c-danger)]'" />
              {{ r.linuxUsername }}
            </span>
          </div>
        </div>

        <!-- Excluded (permitted but unusable) -->
        <div v-if="s.excluded.length" class="space-y-1">
          <div class="eyebrow">Bloqués</div>
          <div v-for="e in s.excluded" :key="e.username" class="text-xs text-[var(--c-warning)]">
            <span class="font-medium">{{ e.username }}</span> — {{ e.reason }}
          </div>
        </div>

        <!-- Guest note -->
        <p v-if="s.guestOk" class="text-[11px] text-[var(--c-text-3)]">Accès invité activé (lecture seule pour les non-authentifiés).</p>

        <!-- Dir detail -->
        <p v-if="s.dir" class="text-[11px] text-[var(--c-text-3)] font-mono">
          groupe {{ s.dir.group || '—' }} · mode {{ s.dir.mode }}<span v-if="!s.dir.exists"> · introuvable</span>
        </p>
      </div>
    </div>
  </div>
</template>
