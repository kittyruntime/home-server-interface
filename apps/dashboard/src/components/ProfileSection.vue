<script setup lang="ts">
import UserAvatar from './UserAvatar.vue'
import { Card } from '@/components/ui/card'
import Tip from './ui/Tip.vue'
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CheckIcon } from '@lucide/vue'
import LoadingState from './ui/LoadingState.vue'
import { ref, reactive, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { useTheme, useAccent, type Accent } from '../lib/theme'
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

const { theme, setTheme } = useTheme()
const { t } = useI18n()
const { accent, setAccent } = useAccent()
const { advancedMode, setAdvancedMode } = useAdvancedMode()
const { confirmFileDelete, setConfirmFileDelete } = useDeleteConfirm()

const THEME_OPTIONS: { value: 'auto' | 'light' | 'dark'; label: string }[] = [
  { value: 'auto',  label: t('uis.settings.ProfileSection.auto')  },
  { value: 'light', label: t('uis.settings.ProfileSection.light') },
  { value: 'dark',  label: t('uis.settings.ProfileSection.dark')  },
]

const ACCENT_OPTIONS: { value: Accent; color: string; label: string }[] = [
  { value: 'orange', color: '#f97316', label: t('uis.settings.ProfileSection.orange') },
  { value: 'blue',   color: '#3b82f6', label: t('uis.settings.ProfileSection.blue')   },
  { value: 'green',  color: '#22c55e', label: t('uis.settings.ProfileSection.green')  },
  { value: 'purple', color: '#a855f7', label: t('uis.settings.ProfileSection.purple') },
]

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
            <span class="text-foreground text-lg font-semibold leading-tight">
              {{ me.displayName || me.username }}
            </span>
            <span v-if="me.displayName" class="text-muted-foreground text-sm">{{ me.username }}</span>
            <span v-if="meIsAdmin" class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-primary/10 text-primary">admin</span>
            <Badge variant="secondary" v-if="!meIsAdmin && meCanManage">manager</Badge>
          </div>
        </div>
      </div>

      <!-- ── Display name ── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.ProfileSection.displayName') }}</h4>
          <Button variant="link" v-if="!editingName" @click="startEditName"
            class="h-auto p-0 text-muted-foreground hover:text-foreground/80">
            {{ t('ui.settings.ProfileSection.edit') }}
          </Button>
        </div>

        <Card v-if="!editingName" class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center justify-between">
          <span :class="me.displayName ? 'text-foreground text-sm' : 'text-muted-foreground text-sm'">
            {{ me.displayName || t('ui.settings.ProfileSection.notSet') }}
          </span>
          <span v-if="nameSuccess" class="text-xs text-success">{{ t('ui.settings.ProfileSection.saved') }}</span>
        </Card>

        <div v-else class="bg-muted border border-input rounded-xl p-4 space-y-3">
          <Input
            v-model="nameValue"
            :placeholder="t('ui.settings.ProfileSection.yourFullName')"
            autofocus
            @keydown.enter="saveName"
            @keydown.escape="editingName = false"
            class="w-full px-3 py-1.5 text-sm"
          />
          <p v-if="nameError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ nameError }}</p>
          <div class="flex gap-2">
            <Button size="sm" @click="saveName" :disabled="nameLoading">
              {{ nameLoading ? 'Saving…' : 'Save' }}
            </Button>
            <Button variant="ghost" size="sm" @click="editingName = false"
              class="text-muted-foreground hover:text-foreground">
              {{ t('ui.settings.ProfileSection.cancel') }}
            </Button>
          </div>
        </div>
      </div>

      <!-- ── Change password ── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.ProfileSection.password') }}</h4>
          <Button variant="link" v-if="!pwOpen" @click="openPassword"
            class="h-auto p-0 text-muted-foreground hover:text-foreground/80">
            {{ t('ui.settings.ProfileSection.change') }}
          </Button>
        </div>

        <Card v-if="!pwOpen" class="block gap-0 py-0 shadow-none px-4 py-3">
          <span class="text-muted-foreground text-sm tracking-widest select-none">••••••••</span>
        </Card>

        <div v-else class="bg-muted border border-input rounded-xl p-4 space-y-3">
          <div v-if="pwSuccess" class="flex items-center gap-2 text-success text-sm py-1">
            <CheckIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
            {{ t('ui.settings.ProfileSection.passwordUpdatedSuccessfully') }}
          </div>

          <template v-else>
            <div>
              <label class="block text-xs text-muted-foreground mb-1">{{ t('ui.settings.ProfileSection.currentPassword') }}</label>
              <Input v-model="pwForm.current" type="password" placeholder="••••••••" autofocus
                class="w-full px-3 py-1.5 text-sm"/>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label class="block text-xs text-muted-foreground mb-1">{{ t('ui.settings.ProfileSection.newPassword') }}</label>
                <Input v-model="pwForm.next" type="password" :placeholder="t('ui.settings.ProfileSection.min6Chars')"
                  class="w-full px-3 py-1.5 text-sm"/>
              </div>
              <div>
                <label class="block text-xs text-muted-foreground mb-1">{{ t('ui.settings.ProfileSection.confirm') }}</label>
                <Input v-model="pwForm.confirm" type="password" :placeholder="t('ui.settings.ProfileSection.repeat')"
                  @keydown.enter="submitPassword"
                  class="w-full px-3 py-1.5 text-sm"/>
              </div>
            </div>
            <p v-if="pwError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ pwError }}</p>
            <div class="flex gap-2">
              <Button size="sm" @click="submitPassword" :disabled="pwLoading || !pwForm.current || !pwForm.next">
                {{ pwLoading ? 'Saving…' : 'Update password' }}
              </Button>
              <Button variant="ghost" size="sm" @click="pwOpen = false"
                class="text-muted-foreground hover:text-foreground">
                {{ t('ui.settings.ProfileSection.cancel') }}
              </Button>
            </div>
          </template>
        </div>
      </div>

      <!-- ── Language ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('profile.language') }}</h4>
        <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            type="single" variant="outline" size="sm"
            :model-value="locale"
            :aria-label="t('profile.language')"
            @update:model-value="v => { if (isLocale(v)) void setLocale(v) }"
          >
            <ToggleGroupItem v-for="l in LOCALES" :key="l.code" :value="l.code" :lang="l.code" class="px-3 text-xs">{{ l.label }}</ToggleGroupItem>
          </ToggleGroup>
          <p class="text-xs text-muted-foreground">{{ t('profile.languageHint') }}</p>
        </Card>
      </div>

      <!-- ── Theme ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.ProfileSection.theme') }}</h4>
        <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center gap-2">
          <ToggleGroup
            type="single" variant="outline" size="sm"
            :model-value="theme"
            :aria-label="t('ui.settings.ProfileSection.theme')"
            @update:model-value="v => { const opt = THEME_OPTIONS.find(o => o.value === v); if (opt) setTheme(opt.value) }"
          >
            <ToggleGroupItem v-for="opt in THEME_OPTIONS" :key="opt.value" :value="opt.value" class="px-3 text-xs">{{ opt.label }}</ToggleGroupItem>
          </ToggleGroup>
        </Card>
      </div>

      <!-- ── Accent color ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.ProfileSection.accentColor') }}</h4>
        <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center gap-3">
          <RadioGroupRoot
            :model-value="accent"
            :aria-label="t('ui.settings.ProfileSection.accentColor')"
            class="flex items-center gap-3"
            @update:model-value="v => { const opt = ACCENT_OPTIONS.find(o => o.value === v); if (opt) setAccent(opt.value) }"
          >
            <Tip v-for="opt in ACCENT_OPTIONS" :key="opt.value" :text="opt.label"><RadioGroupItem
              :value="opt.value"
              :aria-label="opt.label"
              :style="{ backgroundColor: opt.color }"
              class="size-6 rounded-full outline-none transition-all opacity-60 hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:opacity-100 data-[state=checked]:scale-110 data-[state=checked]:ring-2 data-[state=checked]:ring-primary data-[state=checked]:ring-offset-2 data-[state=checked]:ring-offset-card"
            /></Tip>
          </RadioGroupRoot>
          <span class="text-xs text-muted-foreground ml-1">{{ ACCENT_OPTIONS.find(o => o.value === accent)?.label }}</span>
        </Card>
      </div>

      <!-- ── Delete confirmation ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('profile.confirmFileDelete') }}</h4>
        <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center justify-between gap-4">
          <p class="text-xs text-muted-foreground">{{ t('profile.confirmFileDeleteHint') }}</p>
          <Switch :model-value="confirmFileDelete" :aria-label="t('profile.confirmFileDelete')" @update:model-value="setConfirmFileDelete" />
        </Card>
      </div>

      <!-- ── Advanced mode ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.ProfileSection.advancedMode') }}</h4>
        <Card class="gap-0 py-0 shadow-none px-4 py-3 flex flex-row items-center justify-between gap-4">
          <p class="text-xs text-muted-foreground">
            {{ t('ui.settings.ProfileSection.showExtraTechnicalDetailWhere') }}
          </p>
          <Tip text="Advanced mode"><Switch :model-value="advancedMode" @update:model-value="setAdvancedMode" /></Tip>
        </Card>
      </div>

    </template>
  </div>
</template>
