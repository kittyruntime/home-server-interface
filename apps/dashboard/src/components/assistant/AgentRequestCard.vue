<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import BusyLabel from '../ui/BusyLabel.vue'
import { formatDateTime } from '../../lib/format-date'

// One change an AI assistant asked for (#138): what it does, step by step or
// in full, with Approve and Reject while it waits. Used by the requests panel
// and inline in the built-in assistant's chat.

export interface AgentRequest {
  id: string
  title: string
  reason: string | null
  destructive: boolean
  status: string
  createdAt: string | Date
  preview?: unknown
  error?: string | null
  tokenName?: string | null
  conversationId?: string | null
}

type Step = { summary?: string; destructive?: boolean; kind?: string; target?: string; command?: string[]; diff?: string }

const props = defineProps<{ request: AgentRequest; busy: boolean; disabled: boolean; source?: boolean }>()
const emit = defineEmits<{ decide: [approve: boolean] }>()
const { t } = useI18n()

function steps(): Step[] {
  const p = props.request.preview as { steps?: Step[] } | null
  return Array.isArray(p?.steps) ? p.steps : []
}

// A request without a plan (files to delete, a file to replace, an access, an
// update) shows its own details.
function details(): string | null {
  const p = props.request.preview as Record<string, unknown> | null
  if (!p || Array.isArray(p.steps)) return null
  // The whole new content of a replaced file: it is what gets approved.
  if (typeof p.replace === 'string' && typeof p.content === 'string') return p.content
  if (Array.isArray(p.delete)) {
    return (p.delete as Array<{ path: string; type?: string }>).map(i => i.type === 'dir' ? `${i.path}/` : i.path).join('\n')
  }
  return JSON.stringify(p, null, 2)
}

function origin(): string {
  if (props.request.conversationId) return t('agentRequests.builtIn')
  return props.request.tokenName ?? t('agentRequests.unknownToken')
}
</script>

<template>
  <section
    class="rounded-lg border bg-card px-4 py-3"
    :class="request.destructive && request.status === 'pending' ? 'border-destructive/40' : 'border-border'"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-medium text-foreground break-words">{{ request.title }}</p>
        <p class="mt-0.5 text-2xs text-muted-foreground">
          <template v-if="source">{{ origin() }} · </template>{{ formatDateTime(request.createdAt) }}
        </p>
      </div>
      <span v-if="request.status !== 'pending'" class="shrink-0 text-xs font-medium"
        :class="request.status === 'done' ? 'text-success' : request.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
        {{ t(`agentRequests.status.${request.status}`) }}
      </span>
      <span v-else-if="request.destructive" class="shrink-0 text-xs font-medium text-destructive">{{ t('agentRequests.destructive') }}</span>
    </div>
    <p v-if="request.reason" class="mt-2 text-xs text-foreground/80">
      <span class="text-muted-foreground">{{ t('agentRequests.reason') }}</span> {{ request.reason }}
    </p>

    <ol v-if="steps().length" class="mt-3 divide-y divide-border rounded-md border border-border">
      <li v-for="(s, i) in steps()" :key="i" class="px-3 py-2">
        <p class="text-xs" :class="s.destructive ? 'text-destructive' : 'text-foreground'">{{ i + 1 }}. {{ s.summary }}</p>
        <p v-if="s.target" class="mt-0.5 font-mono text-2xs text-muted-foreground">{{ s.target }}</p>
        <details v-if="s.command?.length || s.diff" class="mt-1">
          <summary class="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">{{ t('agentRequests.exactChange') }}</summary>
          <pre class="mt-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-2xs text-foreground">{{ s.command?.join(' ') ?? s.diff }}</pre>
        </details>
      </li>
    </ol>
    <pre v-else-if="details()" class="mt-3 max-h-96 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-2xs text-foreground whitespace-pre-wrap break-all">{{ details() }}</pre>
    <p v-if="request.status === 'failed' && request.error" class="mt-2 text-xs text-destructive break-words">{{ request.error }}</p>

    <div v-if="request.status === 'pending'" class="mt-3 flex justify-end gap-2">
      <Button size="sm" variant="ghost" :disabled="disabled" @click="emit('decide', false)">{{ t('agentRequests.reject') }}</Button>
      <Button size="sm" :variant="request.destructive ? 'destructive' : 'default'" :disabled="disabled" @click="emit('decide', true)">
        <BusyLabel :busy="busy" :busy-label="t('agentRequests.running')">{{ t('agentRequests.approve') }}</BusyLabel>
      </Button>
    </div>
  </section>
</template>
