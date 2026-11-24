import { prisma } from '@app/database'
import { streamChat } from './assistant-provider'
import { assistantAllowed, loadAssistantConfig, recordUsage, tokensUsedToday, usageDay } from './assistant-settings'
import { callTokens } from '../assistant/chat'

// The "today on the server" summary: what HSI already knows (alerts, failed
// tasks, refused sign-ins of the last day) put into a few sentences by the
// assistant's model. Written on request, kept for the day, no tools: the model
// only rewords the facts it is given.

export type DigestFacts = {
  alerts: Array<{ severity: string; message: string }>
  failedTasks: Array<{ action: string; error: string | null }>
  refusedSignIns: number
}

export function digestPrompt(facts: DigestFacts, locale: 'en' | 'fr'): string {
  const lines = [
    `Active alerts (${facts.alerts.length}):`,
    ...facts.alerts.slice(0, 20).map(a => `- [${a.severity}] ${a.message}`),
    `Tasks that failed in the last 24 hours (${facts.failedTasks.length}):`,
    ...facts.failedTasks.slice(0, 10).map(t => `- ${t.action}${t.error ? `: ${t.error.slice(0, 160)}` : ''}`),
    `Refused sign-ins in the last 24 hours: ${facts.refusedSignIns}`,
  ]
  const language = locale === 'fr' ? 'French' : 'English'
  return `You summarize the state of a home server for its owner, in ${language}, in at most three short sentences. `
    + 'Lead with what needs attention, if anything; otherwise say the server is fine. Use only the facts below, never invent any. '
    + 'Plain text, no lists, no markdown, no dashes as punctuation.\n\n' + lines.join('\n')
}

export async function gatherFacts(): Promise<DigestFacts> {
  const since = new Date(Date.now() - 86_400_000)
  const [alerts, failed, refused] = await Promise.all([
    prisma.alert.findMany({ select: { severity: true, message: true }, orderBy: { lastSeenAt: 'desc' } }),
    prisma.job.findMany({ where: { status: 'failed', cancelledAt: null, finishedAt: { gte: since } }, select: { action: true, error: true }, take: 10 }),
    prisma.auditLog.count({ where: { action: 'auth.login', success: false, createdAt: { gte: since } } }),
  ])
  return { alerts, failedTasks: failed, refusedSignIns: refused }
}

const cache = new Map<string, { day: string; text: string; at: string }>()

export function cachedDigest(locale: 'en' | 'fr'): { text: string; at: string } | null {
  const hit = cache.get(locale)
  return hit && hit.day === usageDay() ? { text: hit.text, at: hit.at } : null
}

export class DigestUnavailable extends Error {}

export async function writeDigest(user: { userId: string; isAdmin: boolean }, locale: 'en' | 'fr'): Promise<{ text: string; at: string }> {
  const config = await loadAssistantConfig()
  if (!assistantAllowed(config, user)) throw new DigestUnavailable('The assistant is not set up')
  if (config.dailyTokenLimit !== null && await tokensUsedToday(user.userId) >= config.dailyTokenLimit) {
    throw new DigestUnavailable("The assistant's daily limit is reached")
  }
  const messages = [{ role: 'user' as const, content: digestPrompt(await gatherFacts(), locale) }]
  const signal = AbortSignal.timeout(60_000)
  const reply = await streamChat({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }, messages, [], () => {}, signal,
    { reportUsage: config.provider === 'openrouter' || config.provider === 'openai' })
  await recordUsage(user.userId, 'dashboard-digest', callTokens(messages, 0, reply))
  const text = reply.content.trim().slice(0, 1200)
  const out = { text, at: new Date().toISOString() }
  cache.set(locale, { day: usageDay(), ...out })
  return out
}
