<script setup lang="ts">
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned, previewErrorOf } from '../../lib/plan'
import { randomId } from '../../lib/uuid'
import { asksRepositoryPassword, emptyRepositoryForm, repositoryFormOf, repositoryPayload, WEEKDAYS } from '../../lib/backup'
import PasswordReveal from './PasswordReveal.vue'

type Repository = Awaited<ReturnType<typeof trpc.backup.status.query>>['repositories'][number]

const props = defineProps<{ repository: Repository | null }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()

const form = ref(props.repository ? repositoryFormOf(props.repository) : emptyRepositoryForm(randomId()))
const error = ref('')
// Set when the location already holds a repository (or the password typed was wrong).
const passwordNeeded = ref('')
const generated = ref('')

// On edit the stored secrets are not shown: a blank field keeps them.
const secretPlaceholder = computed(() => props.repository ? 'Unchanged' : '')

async function save() {
  error.value = ''
  try {
    const reply = await applyPlanned('backup.repository.save', repositoryPayload(form.value), {
      title: props.repository ? `Edit the repository ${form.value.name.trim()}` : `Add the repository ${form.value.name.trim()}`,
      actionLabel: 'Save repository',
    })
    if (typeof reply.password === 'string' && reply.password) generated.value = reply.password
    else emit('saved')
  } catch (e) {
    const refused = previewErrorOf(e)
    if (asksRepositoryPassword(refused)) passwordNeeded.value = refused
    else if (e instanceof Error && e.message) error.value = e.message
  }
}
</script>

<template>
  <form class="panel-card p-5 bg-[var(--c-surface)] space-y-4" @submit.prevent="save">
    <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ repository ? 'Edit repository' : 'New repository' }}</h3>

    <div class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-[var(--c-text-2)]">Name
        <input v-model="form.name" required maxlength="80" class="ui-input mt-1" placeholder="USB disk" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Type
        <select v-model="form.type" class="ui-input mt-1">
          <option value="local">Folder on this server</option>
          <option value="sftp">SFTP server</option>
          <option value="s3">S3 bucket</option>
          <option value="rest">restic REST server</option>
        </select>
      </label>
    </div>

    <label v-if="form.type === 'local'" class="block text-xs text-[var(--c-text-2)]">Folder
      <input v-model="form.path" required class="ui-input mt-1 font-mono" placeholder="/mnt/usb/restic" />
    </label>

    <div v-else-if="form.type === 'sftp'" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-[var(--c-text-2)]">Host
        <input v-model="form.host" required class="ui-input mt-1" placeholder="backup.example.net" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">SSH user
        <input v-model="form.user" required class="ui-input mt-1" placeholder="backup" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Port
        <input v-model.number="form.port" type="number" min="1" max="65535" required class="ui-input mt-1 tabular-nums" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Folder on the server
        <input v-model="form.path" required class="ui-input mt-1 font-mono" placeholder="/srv/restic/hsi" />
      </label>
      <label class="text-xs text-[var(--c-text-2)] sm:col-span-2">SSH key path
        <input v-model="form.secrets.sshKeyPath" :required="!repository" class="ui-input mt-1 font-mono" :placeholder="secretPlaceholder || '/root/.ssh/hsi_backup'" />
      </label>
      <p class="sm:col-span-2 text-2xs text-[var(--c-text-3)]">The host must already exist in root's known_hosts and the private key must be mode 0600 or stricter.</p>
    </div>

    <div v-else-if="form.type === 's3'" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-[var(--c-text-2)]">Endpoint
        <input v-model="form.endpoint" required class="ui-input mt-1" placeholder="s3.eu-west-1.amazonaws.com" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Bucket
        <input v-model="form.bucket" required class="ui-input mt-1" placeholder="hsi-backups" />
      </label>
      <label class="text-xs text-[var(--c-text-2)] sm:col-span-2">Prefix (optional)
        <input v-model="form.path" class="ui-input mt-1 font-mono" placeholder="home" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Access key ID
        <input v-model="form.secrets.accessKeyId" :required="!repository" autocomplete="off" class="ui-input mt-1 font-mono" :placeholder="secretPlaceholder" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Secret access key
        <input v-model="form.secrets.secretAccessKey" :required="!repository" type="password" autocomplete="new-password" class="ui-input mt-1" :placeholder="secretPlaceholder" />
      </label>
    </div>

    <div v-else class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-[var(--c-text-2)] sm:col-span-2">Server URL
        <input v-model="form.url" required type="url" class="ui-input mt-1 font-mono" placeholder="https://backup.lan:8000/hsi/" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">User (optional)
        <input v-model="form.secrets.restUser" autocomplete="off" class="ui-input mt-1" :placeholder="secretPlaceholder" />
      </label>
      <label class="text-xs text-[var(--c-text-2)]">Password (optional)
        <input v-model="form.secrets.restPassword" type="password" autocomplete="new-password" class="ui-input mt-1" :placeholder="secretPlaceholder" />
      </label>
    </div>

    <div v-if="passwordNeeded" class="space-y-2">
      <p class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ passwordNeeded }}</p>
      <label class="block text-xs text-[var(--c-text-2)]">Existing repository password
        <input v-model="form.secrets.password" required type="password" autocomplete="off" class="ui-input mt-1 w-full" />
      </label>
    </div>

    <!-- Integrity check -->
    <div>
      <p class="text-xs text-[var(--c-text-2)]">Integrity check</p>
      <div class="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="text-2xs text-[var(--c-text-3)]">Schedule
          <select v-model="form.check.every" class="ui-input mt-1">
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label v-if="form.check.every === 'weekly'" class="text-2xs text-[var(--c-text-3)]">Day
          <select v-model.number="form.check.weekday" class="ui-input mt-1">
            <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
          </select>
        </label>
        <label v-if="form.check.every === 'monthly'" class="text-2xs text-[var(--c-text-3)]">Day of the month
          <input v-model.number="form.check.day" type="number" min="1" max="28" required class="ui-input mt-1 tabular-nums" />
        </label>
        <label v-if="form.check.every !== 'off'" class="text-2xs text-[var(--c-text-3)]">Hour
          <input v-model.number="form.check.hour" type="number" min="0" max="23" required class="ui-input mt-1 tabular-nums" />
        </label>
        <label v-if="form.check.every !== 'off'" class="text-2xs text-[var(--c-text-3)]">Data read back (%)
          <input v-model.number="form.check.subsetPercent" type="number" min="1" max="100" required class="ui-input mt-1 tabular-nums" />
        </label>
      </div>
    </div>

    <p v-if="!repository" class="text-2xs text-[var(--c-text-3)]">An empty location gets a new encrypted repository and a generated password, shown once after saving.</p>
    <p v-if="error" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div class="flex gap-2">
      <button type="submit" class="btn btn-primary btn-sm">Review repository</button>
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
    </div>

    <PasswordReveal v-if="generated" mode="new" :repository="{ id: form.id, name: form.name.trim() }" :password="generated" @close="emit('saved')" />
  </form>
</template>
