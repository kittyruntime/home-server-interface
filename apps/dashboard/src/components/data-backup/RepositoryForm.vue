<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned, previewCodeOf, previewErrorOf } from '../../lib/plan'
import { randomId } from '../../lib/uuid'
import { asksRepositoryPassword, emptyRepositoryForm, locationSecretsRequired, repositoryFormOf, repositoryPayload, WEEKDAYS } from '../../lib/backup'
import PasswordReveal from './PasswordReveal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()

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
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.name') }}
        <Input v-model="form.name" required maxlength="80" class="mt-1" :placeholder="t('ui.backups.RepositoryForm.usbDisk')" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.type') }}
        <NativeSelect wrapper-class="mt-1" v-model="form.type">
          <NativeSelectOption value="local">{{ t('ui.backups.RepositoryForm.folderOnThisServer') }}</NativeSelectOption>
          <NativeSelectOption value="sftp">{{ t('ui.backups.RepositoryForm.sftpServer') }}</NativeSelectOption>
          <NativeSelectOption value="s3">{{ t('ui.backups.RepositoryForm.s3Bucket') }}</NativeSelectOption>
          <NativeSelectOption value="rest">{{ t('ui.backups.RepositoryForm.resticRestServer') }}</NativeSelectOption>
        </NativeSelect>
      </label>
    </div>

    <label v-if="form.type === 'local'" class="block text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.folder') }}
      <Input v-model="form.path" required class="mt-1 font-mono" laceholder="/mnt/usb/restic" />
    </label>

    <div v-else-if="form.type === 'sftp'" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.host') }}
        <Input v-model="form.host" required class="mt-1" :placeholder="t('ui.backups.RepositoryForm.backupExampleNet')" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.sshUser') }}
        <Input v-model="form.user" required class="mt-1" laceholder="backup" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.port') }}
        <Input v-model.number="form.port" type="number" min="1" max="65535" required class="mt-1 tabular-nums" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.folderOnTheServer') }}
        <Input v-model="form.path" required class="mt-1 font-mono" laceholder="/srv/restic/hsi" />
      </label>
      <label class="text-xs text-foreground/80 sm:col-span-2">{{ t('ui.backups.RepositoryForm.sshKeyPath') }}
        <Input v-model="form.secrets.sshKeyPath" :required="secretsRequired" class="mt-1 font-mono" :placeholder="secretPlaceholder || '/root/.ssh/hsi_backup'" />
      </label>
      <p class="sm:col-span-2 text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.theHostMustAlreadyExist') }}</p>
    </div>

    <div v-else-if="form.type === 's3'" class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.endpoint') }}
        <Input v-model="form.endpoint" required class="mt-1" :placeholder="t('ui.backups.RepositoryForm.s3EuWest1Amazonaws')" />
        <span class="mt-1 block text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.httpsUnlessItStartsWith') }}</span>
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.bucket') }}
        <Input v-model="form.bucket" required class="mt-1" laceholder="hsi-backups" />
      </label>
      <label class="text-xs text-foreground/80 sm:col-span-2">{{ t('ui.backups.RepositoryForm.prefixOptional') }}
        <Input v-model="form.path" class="mt-1 font-mono" laceholder="home" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.accessKeyId') }}
        <Input v-model="form.secrets.accessKeyId" :required="secretsRequired" autocomplete="off" class="mt-1 font-mono" :placeholder="secretPlaceholder" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.secretAccessKey') }}
        <Input v-model="form.secrets.secretAccessKey" :required="secretsRequired" type="password" autocomplete="new-password" class="mt-1" :placeholder="secretPlaceholder" />
      </label>
    </div>

    <div v-else class="grid gap-3 sm:grid-cols-2">
      <label class="text-xs text-foreground/80 sm:col-span-2">{{ t('ui.backups.RepositoryForm.serverUrl') }}
        <Input v-model="form.url" required type="url" class="mt-1 font-mono" laceholder="https://backup.lan:8000/hsi/" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.userOptional') }}
        <Input v-model="form.secrets.restUser" autocomplete="off" class="mt-1" :placeholder="secretPlaceholder" />
      </label>
      <label class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.passwordOptional') }}
        <Input v-model="form.secrets.restPassword" type="password" autocomplete="new-password" class="mt-1" :placeholder="secretPlaceholder" />
      </label>
    </div>

    <div v-if="passwordNeeded" class="space-y-2">
      <p class="status-text text-warning"><span class="status-tag">[WARN]</span> {{ passwordNeeded }}</p>
      <label class="block text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.existingRepositoryPassword') }}
        <Input v-model="form.secrets.password" required type="password" autocomplete="off" class="mt-1 w-full" />
      </label>
    </div>

    <!-- Integrity check -->
    <div>
      <p class="text-xs text-foreground/80">{{ t('ui.backups.RepositoryForm.integrityCheck') }}</p>
      <div class="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label class="text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.schedule') }}
          <NativeSelect wrapper-class="mt-1" v-model="form.check.every">
            <NativeSelectOption value="off">{{ t('ui.backups.RepositoryForm.off') }}</NativeSelectOption>
            <NativeSelectOption value="daily">{{ t('ui.backups.RepositoryForm.daily') }}</NativeSelectOption>
            <NativeSelectOption value="weekly">{{ t('ui.backups.RepositoryForm.weekly') }}</NativeSelectOption>
            <NativeSelectOption value="monthly">{{ t('ui.backups.RepositoryForm.monthly') }}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label v-if="form.check.every === 'weekly'" class="text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.day') }}
          <NativeSelect wrapper-class="mt-1" v-model.number="form.check.weekday">
            <NativeSelectOption v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label v-if="form.check.every === 'monthly'" class="text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.dayOfTheMonth') }}
          <Input v-model.number="form.check.day" type="number" min="1" max="28" required class="mt-1 tabular-nums" />
        </label>
        <label v-if="form.check.every !== 'off'" class="text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.hour') }}
          <Input v-model.number="form.check.hour" type="number" min="0" max="23" required class="mt-1 tabular-nums" />
        </label>
        <label v-if="form.check.every !== 'off'" class="text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.dataReadBack') }}
          <Input v-model.number="form.check.subsetPercent" type="number" min="1" max="100" required class="mt-1 tabular-nums" />
        </label>
      </div>
    </div>

    <p v-if="!repository" class="text-2xs text-muted-foreground">{{ t('ui.backups.RepositoryForm.anEmptyLocationGetsA') }}</p>
    <p v-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div class="flex gap-2">
      <Button size="sm" type="submit">{{ t('ui.backups.RepositoryForm.reviewRepository') }}</Button>
      <Button variant="ghost" size="sm" type="button" @click="emit('cancel')">{{ t('ui.backups.RepositoryForm.cancel') }}</Button>
    </div>

    <PasswordReveal v-if="generated" mode="new" :repository="{ id: form.id, name: form.name.trim() }" :password="generated" @close="emit('saved')" />
  </form>
</template>
