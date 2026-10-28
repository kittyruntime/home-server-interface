<script setup lang="ts">
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned, previewCodeOf, previewErrorOf } from '../../lib/plan'
import { randomId } from '../../lib/uuid'
import { asksRepositoryPassword, emptyRepositoryForm, locationSecretsRequired, repositoryFormOf, repositoryPayload, WEEKDAYS } from '../../lib/backup'
import PasswordReveal from './PasswordReveal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

type Repository = Awaited<ReturnType<typeof trpc.backup.status.query>>['repositories'][number]

const props = defineProps<{ repository: Repository | null }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()

const form = ref(props.repository ? repositoryFormOf(props.repository) : emptyRepositoryForm(randomId()))
const error = ref('')
// Set when the location already holds a repository (or the password typed was wrong).
const passwordNeeded = ref('')
const generated = ref('')

// On edit the stored secrets are not shown: a blank field keeps them. A new type
// has none stored, so its keys are required.
const secretsRequired = computed(() => locationSecretsRequired(props.repository?.type ?? null, form.value.type))
const secretPlaceholder = computed(() => secretsRequired.value ? '' : 'Unchanged')

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
    if (asksRepositoryPassword(previewCodeOf(e))) passwordNeeded.value = refused
    else if (refused) error.value = refused
    else if (e instanceof Error && e.message) error.value = e.message
  }
}
</script>

<template>
  <form class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden p-5 bg-card space-y-4" @submit.prevent="save">
    <h3 class="text-sm font-semibold text-foreground">{{ repository ? 'Edit repository' : 'New repository' }}</h3>

    <div class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80">Name
        <Input v-model="form.name" required maxlength="80" class="mt-1" placeholder="USB disk" />
      </label>
      <label class="text-xs text-foreground/80">Type
        <NativeSelect wrapper-class="mt-1" v-model="form.type">
          <NativeSelectOption value="local">Folder on this server</NativeSelectOption>
          <NativeSelectOption value="sftp">SFTP server</NativeSelectOption>
          <NativeSelectOption value="s3">S3 bucket</NativeSelectOption>
          <NativeSelectOption value="rest">restic REST server</NativeSelectOption>
        </NativeSelect>
      </label>
    </div>

    <label v-if="form.type === 'local'" class="block text-xs text-foreground/80">Folder
      <Input v-model="form.path" required class="mt-1 font-mono" placeholder="/mnt/usb/restic" />
    </label>

    <div v-else-if="form.type === 'sftp'" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80">Host
        <Input v-model="form.host" required class="mt-1" placeholder="backup.example.net" />
      </label>
      <label class="text-xs text-foreground/80">SSH user
        <Input v-model="form.user" required class="mt-1" placeholder="backup" />
      </label>
      <label class="text-xs text-foreground/80">Port
        <Input v-model.number="form.port" type="number" min="1" max="65535" required class="mt-1 tabular-nums" />
      </label>
      <label class="text-xs text-foreground/80">Folder on the server
        <Input v-model="form.path" required class="mt-1 font-mono" placeholder="/srv/restic/hsi" />
      </label>
      <label class="text-xs text-foreground/80 sm:col-span-2">SSH key path
        <Input v-model="form.secrets.sshKeyPath" :required="secretsRequired" class="mt-1 font-mono" :placeholder="secretPlaceholder || '/root/.ssh/hsi_backup'" />
      </label>
      <p class="sm:col-span-2 text-2xs text-muted-foreground">The host must already exist in root's known_hosts and the private key must be mode 0600 or stricter.</p>
    </div>

    <div v-else-if="form.type === 's3'" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80">Endpoint
        <Input v-model="form.endpoint" required class="mt-1" placeholder="s3.eu-west-1.amazonaws.com" />
        <span class="mt-1 block text-2xs text-muted-foreground">HTTPS unless it starts with http://, e.g. http://minio.lan:9000 on the local network.</span>
      </label>
      <label class="text-xs text-foreground/80">Bucket
        <Input v-model="form.bucket" required class="mt-1" placeholder="hsi-backups" />
      </label>
      <label class="text-xs text-foreground/80 sm:col-span-2">Prefix (optional)
        <Input v-model="form.path" class="mt-1 font-mono" placeholder="home" />
      </label>
      <label class="text-xs text-foreground/80">Access key ID
        <Input v-model="form.secrets.accessKeyId" :required="secretsRequired" autocomplete="off" class="mt-1 font-mono" :placeholder="secretPlaceholder" />
      </label>
      <label class="text-xs text-foreground/80">Secret access key
        <Input v-model="form.secrets.secretAccessKey" :required="secretsRequired" type="password" autocomplete="new-password" class="mt-1" :placeholder="secretPlaceholder" />
      </label>
    </div>

    <div v-else class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80 sm:col-span-2">Server URL
        <Input v-model="form.url" required type="url" class="mt-1 font-mono" placeholder="https://backup.lan:8000/hsi/" />
      </label>
      <label class="text-xs text-foreground/80">User (optional)
        <Input v-model="form.secrets.restUser" autocomplete="off" class="mt-1" :placeholder="secretPlaceholder" />
      </label>
      <label class="text-xs text-foreground/80">Password (optional)
        <Input v-model="form.secrets.restPassword" type="password" autocomplete="new-password" class="mt-1" :placeholder="secretPlaceholder" />
      </label>
    </div>

    <div v-if="passwordNeeded" class="space-y-2">
      <p class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ passwordNeeded }}</p>
      <label class="block text-xs text-foreground/80">Existing repository password
        <Input v-model="form.secrets.password" required type="password" autocomplete="off" class="mt-1 w-full" />
      </label>
    </div>

    <!-- Integrity check -->
    <div>
      <p class="text-xs text-foreground/80">Integrity check</p>
      <div class="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="text-2xs text-muted-foreground">Schedule
          <NativeSelect wrapper-class="mt-1" v-model="form.check.every">
            <NativeSelectOption value="off">Off</NativeSelectOption>
            <NativeSelectOption value="daily">Daily</NativeSelectOption>
            <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
            <NativeSelectOption value="monthly">Monthly</NativeSelectOption>
          </NativeSelect>
        </label>
        <label v-if="form.check.every === 'weekly'" class="text-2xs text-muted-foreground">Day
          <NativeSelect wrapper-class="mt-1" v-model.number="form.check.weekday">
            <NativeSelectOption v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label v-if="form.check.every === 'monthly'" class="text-2xs text-muted-foreground">Day of the month
          <Input v-model.number="form.check.day" type="number" min="1" max="28" required class="mt-1 tabular-nums" />
        </label>
        <label v-if="form.check.every !== 'off'" class="text-2xs text-muted-foreground">Hour
          <Input v-model.number="form.check.hour" type="number" min="0" max="23" required class="mt-1 tabular-nums" />
        </label>
        <label v-if="form.check.every !== 'off'" class="text-2xs text-muted-foreground">Data read back (%)
          <Input v-model.number="form.check.subsetPercent" type="number" min="1" max="100" required class="mt-1 tabular-nums" />
        </label>
      </div>
    </div>

    <p v-if="!repository" class="text-2xs text-muted-foreground">An empty location gets a new encrypted repository and a generated password, shown once after saving.</p>
    <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div class="flex gap-2">
      <Button size="sm" type="submit">Review repository</Button>
      <Button variant="ghost" size="sm" type="button" @click="emit('cancel')">Cancel</Button>
    </div>

    <PasswordReveal v-if="generated" mode="new" :repository="{ id: form.id, name: form.name.trim() }" :password="generated" @close="emit('saved')" />
  </form>
</template>
