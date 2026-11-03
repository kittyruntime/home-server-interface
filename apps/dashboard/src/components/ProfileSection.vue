<script setup lang="ts">
import UserAvatar from './UserAvatar.vue'
import { Card } from '@/components/ui/card'
import Tip from './ui/Tip.vue'
import AppearanceSection from './AppearanceSection.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { CheckIcon, ChevronDownIcon } from '@lucide/vue'
import LoadingState from './ui/LoadingState.vue'
import { ref, reactive, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { LOCALES, isLocale, locale, setLocale } from '../i18n'
import { useI18n } from 'vue-i18n'
import { useAdvancedMode } from '../lib/advanced-mode'
import { useDeleteConfirm } from '../lib/delete-confirm'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Me = {
  id: string
  username: string
  displayName: string | null
  isAdmin: boolean
  isUserManager: boolean
}

const meIsAdmin = computed(() => me.value?.isAdmin === true)
const meCanManage = computed(() => !!me.value && (me.value.isAdmin || me.value.isUserManager))

const { setToken } = useAuth()

const { t } = useI18n()
const { advancedMode, setAdvancedMode } = useAdvancedMode()
const { confirmFileDelete, setConfirmFileDelete } = useDeleteConfirm()

const me      = ref<Me | null>(null)
const loading = ref(true)

// ── Display name ──────────────────────────────────────────────────────────────
const editingName  = ref(false)
const nameValue    = ref('')
const nameLoading  = ref(false)
const nameError    = ref('')
const nameSuccess  = ref(false)

function startEditName() {
  nameValue.value  = me.value?.displayName ?? ''
  nameError.value  = ''
  nameSuccess.value = false
  editingName.value = true
}

async function saveName() {
  nameError.value = ''
  nameLoading.value = true
  try {
    const updated = await trpc.user.updateSelf.mutate({ displayName: nameValue.value.trim() || null })
    me.value = { ...me.value!, displayName: (updated as any).displayName }
    editingName.value = false
    nameSuccess.value = true
    setTimeout(() => { nameSuccess.value = false }, 3000)
  } catch (e: any) {
    nameError.value = e?.message ?? t('uis.settings.ProfileSection.failedToUpdate')
  } finally {
    nameLoading.value = false
  }
}

// ── Change password ───────────────────────────────────────────────────────────
const pwOpen    = ref(false)
const pwForm    = reactive({ current: '', next: '', confirm: '' })
const pwError   = ref('')
const pwSuccess = ref(false)
const pwLoading = ref(false)

function openPassword() {
  pwSuccess.value = false
  pwError.value   = ''
  Object.assign(pwForm, { current: '', next: '', confirm: '' })
  pwOpen.value = true
}

async function submitPassword() {
  pwError.value   = ''
  pwSuccess.value = false
  if (pwForm.next !== pwForm.confirm) { pwError.value = t('uis.settings.ProfileSection.passwordsDoNotMatch'); return }
  if (pwForm.next.length < 6)         { pwError.value = t('uis.settings.ProfileSection.newPasswordMustBeAt'); return }
  pwLoading.value = true
  try {
    const result = await trpc.user.changePassword.mutate({ currentPassword: pwForm.current, newPassword: pwForm.next })
    setToken(result.token)
    pwSuccess.value = true
    Object.assign(pwForm, { current: '', next: '', confirm: '' })
  } catch (e: any) {
    pwError.value = e?.message ?? t('uis.settings.ProfileSection.failedToChangePassword')
  } finally {
    pwLoading.value = false
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

onMounted(async () => {
  try { me.value = (await trpc.user.me.query()) as Me }
  finally { loading.value = false }
})
</script>

<template>
  <div class="space-y-8">

    <!-- Loading -->
    <LoadingState v-if="loading" variant="block" />

    <template v-else-if="me">

      <!-- ── Identity card ── -->
      <div class="flex items-center gap-4">
        <!-- Avatar -->
        <UserAvatar :username="me.username" class="size-14 rounded-xl text-lg" />

        <!-- Name + badges -->
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-base-content text-lg font-semibold leading-tight">
              {{ me.displayName || me.username }}
            </span>
            <span v-if="me.displayName" class="text-base-content/70 text-sm">{{ me.username }}</span>
            <span v-if="meIsAdmin" class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-primary/10 text-primary">admin</span>
            <Badge variant="secondary" v-if="!meIsAdmin && meCanManage">manager</Badge>
          </div>
        </div>
      </div>

      <!-- ── Display name ── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('ui.settings.ProfileSection.displayName') }}</h4>
          <Button variant="link" v-if="!editingName" @click="startEditName"
            class="h-auto p-0 text-base-content/70 hover:text-base-content/80">
            {{ t('ui.settings.ProfileSection.edit') }}
          </Button>
        </div>

        <Card v-if="!editingName" class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center justify-between">
          <span :class="me.displayName ? 'text-base-content text-sm' : 'text-base-content/70 text-sm'">
            {{ me.displayName || t('ui.settings.ProfileSection.notSet') }}
          </span>
          <span v-if="nameSuccess" class="text-xs text-success">{{ t('ui.settings.ProfileSection.saved') }}</span>
        </Card>

        <div v-else class="bg-base-200 border border-base-300 rounded-xl p-4 space-y-3">
          <Input
            v-model="nameValue"
            :placeholder="t('ui.settings.ProfileSection.yourFullName')"
            autofocus
            @keydown.enter="saveName"
            @keydown.escape="editingName = false"
            class="w-full px-3 py-1.5 text-sm"
          />
          <p v-if="nameError" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ nameError }}</p>
          <div class="flex gap-2">
            <Button size="sm" @click="saveName" :disabled="nameLoading">
              {{ nameLoading ? 'Saving…' : 'Save' }}
            </Button>
            <Button variant="ghost" size="sm" @click="editingName = false"
              class="text-base-content/70 hover:text-base-content">
              {{ t('ui.settings.ProfileSection.cancel') }}
            </Button>
          </div>
        </div>
      </div>

      <!-- ── Change password ── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('ui.settings.ProfileSection.password') }}</h4>
          <Button variant="link" v-if="!pwOpen" @click="openPassword"
            class="h-auto p-0 text-base-content/70 hover:text-base-content/80">
            {{ t('ui.settings.ProfileSection.change') }}
          </Button>
        </div>

        <Card v-if="!pwOpen" class="block gap-0 py-0 shadow-none px-4 py-3">
          <span class="text-base-content/70 text-sm tracking-widest select-none">••••••••</span>
        </Card>

        <div v-else class="bg-base-200 border border-base-300 rounded-xl p-4 space-y-3">
          <div v-if="pwSuccess" class="flex items-center gap-2 text-success text-sm py-1">
            <CheckIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
            {{ t('ui.settings.ProfileSection.passwordUpdatedSuccessfully') }}
          </div>

          <template v-else>
            <div>
              <label class="block text-xs text-base-content/70 mb-1">{{ t('ui.settings.ProfileSection.currentPassword') }}</label>
              <Input v-model="pwForm.current" type="password" placeholder="••••••••" autofocus
                class="w-full px-3 py-1.5 text-sm"/>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label class="block text-xs text-base-content/70 mb-1">{{ t('ui.settings.ProfileSection.newPassword') }}</label>
                <Input v-model="pwForm.next" type="password" :placeholder="t('ui.settings.ProfileSection.min6Chars')"
                  class="w-full px-3 py-1.5 text-sm"/>
              </div>
              <div>
                <label class="block text-xs text-base-content/70 mb-1">{{ t('ui.settings.ProfileSection.confirm') }}</label>
                <Input v-model="pwForm.confirm" type="password" :placeholder="t('ui.settings.ProfileSection.repeat')"
                  @keydown.enter="submitPassword"
                  class="w-full px-3 py-1.5 text-sm"/>
              </div>
            </div>
            <p v-if="pwError" role="alert" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ pwError }}</p>
            <div class="flex gap-2">
              <Button size="sm" @click="submitPassword" :disabled="pwLoading || !pwForm.current || !pwForm.next">
                {{ pwLoading ? 'Saving…' : 'Update password' }}
              </Button>
              <Button variant="ghost" size="sm" @click="pwOpen = false"
                class="text-base-content/70 hover:text-base-content">
                {{ t('ui.settings.ProfileSection.cancel') }}
              </Button>
            </div>
          </template>
        </div>
      </div>

      <!-- ── Language ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('profile.language') }}</h4>
        <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row flex-wrap items-center justify-between gap-3">
          <NativeSelect
            :model-value="locale"
            :aria-label="t('profile.language')"
            wrapper-class="w-auto"
            class="select-sm"
            @update:model-value="v => { if (isLocale(v)) void setLocale(v) }"
          >
            <NativeSelectOption v-for="l in LOCALES" :key="l.code" :value="l.code" :lang="l.code">{{ l.label }}</NativeSelectOption>
          </NativeSelect>
          <p class="text-xs text-base-content/70">{{ t('profile.languageHint') }}</p>
        </Card>
      </div>

      <!-- ── Appearance ── -->
      <Collapsible class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">
          <CollapsibleTrigger class="group flex w-full items-center justify-between text-left outline-none focus-visible:ring-3 focus-visible:ring-base-content/30 rounded-sm">
            {{ t('profile.appearance') }}
            <ChevronDownIcon class="size-3.5 text-base-content/70 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          </CollapsibleTrigger>
        </h4>
        <CollapsibleContent class="space-y-8 pt-2">
          <AppearanceSection />
        </CollapsibleContent>
      </Collapsible>

      <!-- ── Advanced options ── -->
      <Collapsible class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">
          <CollapsibleTrigger class="group flex w-full items-center justify-between text-left outline-none focus-visible:ring-3 focus-visible:ring-base-content/30 rounded-sm">
            {{ t('profile.advancedOptions') }}
            <ChevronDownIcon class="size-3.5 text-base-content/70 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          </CollapsibleTrigger>
        </h4>
        <CollapsibleContent class="space-y-8 pt-2">
          <!-- ── Delete confirmation ── -->
          <div class="space-y-2">
            <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('profile.confirmFileDelete') }}</h4>
            <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center justify-between gap-4">
              <p class="text-xs text-base-content/70">{{ t('profile.confirmFileDeleteHint') }}</p>
              <Switch :model-value="confirmFileDelete" :aria-label="t('profile.confirmFileDelete')" @update:model-value="setConfirmFileDelete" />
            </Card>
          </div>

          <!-- ── Advanced mode ── -->
          <div class="space-y-2">
            <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('ui.settings.ProfileSection.advancedMode') }}</h4>
            <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center justify-between gap-4">
              <p class="text-xs text-base-content/70">
                {{ t('ui.settings.ProfileSection.showExtraTechnicalDetailWhere') }}
              </p>
              <Tip :text="t('ui.settings.ProfileSection.advancedMode')"><Switch :model-value="advancedMode" @update:model-value="setAdvancedMode" /></Tip>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>

    </template>
  </div>
</template>
