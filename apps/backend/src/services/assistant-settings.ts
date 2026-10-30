import { prisma } from "@app/database"
import { decryptSecret, encryptSecret } from "./secrets"

// The built-in assistant's settings: which model it talks to, with which key,
// and who may use it. A single row, set by an administrator. The API key is
// encrypted at rest and never leaves the server.

export const ASSISTANT_PROVIDERS = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  openai: { baseUrl: "https://api.openai.com/v1", needsKey: true },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", needsKey: true },
  mistral: { baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  custom: { baseUrl: "", needsKey: false },
} as const
export type AssistantProvider = keyof typeof ASSISTANT_PROVIDERS

export type AssistantAccess = "admins" | "everyone"

export interface AssistantConfig {
  enabled: boolean
  provider: AssistantProvider
  baseUrl: string
  apiKey: string | null
  model: string
  access: AssistantAccess
}

type Row = { enabled: boolean; provider: string; baseUrl: string; apiKey: string | null; model: string; access: string }

function fromRow(row: Row | null): AssistantConfig {
  const provider = (row?.provider ?? "openrouter") in ASSISTANT_PROVIDERS ? (row?.provider ?? "openrouter") as AssistantProvider : "custom"
  let apiKey: string | null = null
  if (row?.apiKey) {
    try { apiKey = decryptSecret(row.apiKey) } catch { apiKey = null }
  }
  return {
    enabled: row?.enabled ?? false,
    provider,
    baseUrl: row?.baseUrl ?? ASSISTANT_PROVIDERS.openrouter.baseUrl,
    apiKey,
    model: row?.model ?? "",
    access: row?.access === "everyone" ? "everyone" : "admins",
  }
}

export async function loadAssistantConfig(): Promise<AssistantConfig> {
  return fromRow(await prisma.assistantSettings.findUnique({ where: { id: 1 } }))
}

/** Settings as the dashboard sees them: whether a key is set, never the key. */
export async function assistantSettingsView() {
  const row = await prisma.assistantSettings.findUnique({ where: { id: 1 } })
  const config = fromRow(row)
  return {
    enabled: config.enabled,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    access: config.access,
    keySet: !!row?.apiKey,
    // A key that no longer decrypts (HSI_SECRETS_KEY changed): enter it again.
    keyUnreadable: !!row?.apiKey && config.apiKey === null,
  }
}

export interface AssistantSettingsInput {
  enabled: boolean
  provider: AssistantProvider
  baseUrl: string
  model: string
  access: AssistantAccess
  /** undefined: keep the stored key; null: remove it. */
  apiKey?: string | null
}

export async function saveAssistantSettings(input: AssistantSettingsInput) {
  const apiKey = input.apiKey === undefined ? undefined : input.apiKey === null ? null : encryptSecret(input.apiKey)
  const data = {
    enabled: input.enabled, provider: input.provider, baseUrl: input.baseUrl.replace(/\/+$/, ""),
    model: input.model, access: input.access,
    ...(apiKey !== undefined && { apiKey }),
  }
  await prisma.assistantSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data })
}

/** Whether the configuration can reach a model at all. */
export function assistantReady(config: AssistantConfig): boolean {
  if (!config.enabled || !config.model || !config.baseUrl) return false
  return !ASSISTANT_PROVIDERS[config.provider].needsKey || !!config.apiKey
}

/** Whether this account may use the assistant. */
export function assistantAllowed(config: AssistantConfig, user: { isAdmin: boolean }): boolean {
  return assistantReady(config) && (config.access === "everyone" || user.isAdmin)
}
