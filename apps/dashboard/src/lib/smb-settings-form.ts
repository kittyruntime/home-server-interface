import { computed, ref, watch, type Ref } from 'vue'
import { trpc } from './trpc'
import { applyPlanned } from './plan'
import type { SharingService } from './sharing-types'

type Settings = SharingService['settings']

export const SMB_FIELDS = ['netbiosName', 'workgroup', 'minProtocol', 'encryption', 'discoveryWsd', 'discoveryMdns'] as const
export const BLOCK_FIELDS = ['autoBlock', 'blockThreshold', 'blockWindowMin', 'blockForMin'] as const
type Field = typeof SMB_FIELDS[number] | typeof BLOCK_FIELDS[number]

// Same rules as the server, checked as the owner types.
const reName = /^[A-Za-z0-9-]{0,15}$/
export const LIMITS = { blockThreshold: [1, 100], blockWindowMin: [1, 1440], blockForMin: [1, 10080] } as const
type NumField = keyof typeof LIMITS

/**
 * A form over some of the sharing settings. It edits a copy; `saved` is what
 * the server holds, so a save keeps the fields on screen while the service
 * restarts, and fresh values from the server replace the fields unless the
 * owner is editing them. Only changed fields are sent.
 */
export function useSmbSettingsForm<F extends Field>(service: Ref<SharingService | null>, fields: readonly F[], labels: { title: string; action: string; failed: string }) {
  type Values = Pick<Settings, F>
  const pick = (s: Values): Values => Object.fromEntries(fields.map(f => [f, s[f]])) as Values
  const form = ref<Values | null>(null) as Ref<Values | null>
  const saved = ref<Values | null>(null) as Ref<Values | null>
  const saving = ref(false)
  const error = ref('')

  const patch = computed(() => {
    const out: Partial<Values> = {}
    if (!saved.value || !form.value) return out
    for (const f of fields) if (form.value[f] !== saved.value[f]) out[f] = form.value[f]
    return out
  })
  const dirty = computed(() => Object.keys(patch.value).length > 0)

  watch(() => service.value?.settings, s => {
    if (!s || dirty.value || saving.value) return
    saved.value = pick(s)
    form.value = pick(s)
  }, { immediate: true })

  const invalid = computed(() => {
    const out: Partial<Record<Field, boolean>> = {}
    const f = form.value as Partial<Settings> | null
    if (!f) return out
    for (const k of ['netbiosName', 'workgroup'] as const) if (k in f) out[k] = !reName.test(f[k] ?? '')
    if (f.autoBlock) {
      for (const k of Object.keys(LIMITS) as NumField[]) {
        const v = f[k]
        const [lo, hi] = LIMITS[k]
        out[k] = typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi
      }
    }
    return out
  })
  const hasInvalid = computed(() => Object.values(invalid.value).some(Boolean))

  function reset() {
    if (saved.value) form.value = { ...saved.value }
    error.value = ''
  }

  /** True once the server applied the change. */
  async function save(): Promise<boolean> {
    if (!dirty.value || hasInvalid.value || saving.value) return false
    saving.value = true
    error.value = ''
    try {
      await applyPlanned('smb.settings', patch.value, { domain: 'sharing', title: labels.title, actionLabel: labels.action })
      saved.value = { ...form.value! }
      return true
    } catch (e) {
      error.value = (e as Error).message || labels.failed
      return false
    } finally {
      saving.value = false
    }
  }

  return { form, dirty, invalid, hasInvalid, saving, error, reset, save }
}

export type SmbBlock = Awaited<ReturnType<typeof trpc.sharing.blocks.query>>[number]
