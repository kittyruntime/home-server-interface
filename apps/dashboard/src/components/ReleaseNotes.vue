<script setup lang="ts">
import { computed } from 'vue'

/* Minimal, dependency-free renderer for the subset of Markdown that shows up in
   our GitHub release notes: headings, bullet lists, bold, inline code and links.
   Everything is rendered through Vue text interpolation (never v-html) and only
   http(s) links are kept, so the release body cannot inject markup. */

const props = defineProps<{ source: string }>()

type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string }

type Block =
  | { k: 'h';  children: Inline[] }
  | { k: 'li'; children: Inline[] }
  | { k: 'p';  children: Inline[] }

const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g

function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: 'bold', v: m[1] })
    else if (m[2] !== undefined) out.push({ t: 'code', v: m[2] })
    else if (m[3] !== undefined) {
      const href = m[4] ?? ''
      out.push(/^https?:\/\//i.test(href) ? { t: 'link', v: m[3], href } : { t: 'text', v: m[3] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

function parse(md: string): Block[] {
  const blocks: Block[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) { blocks.push({ k: 'h', children: parseInline(h[1] ?? '') }); continue }
    const li = /^[-*]\s+(.*)$/.exec(line)
    if (li) { blocks.push({ k: 'li', children: parseInline(li[1] ?? '') }); continue }
    blocks.push({ k: 'p', children: parseInline(line) })
  }
  return blocks
}

const blocks = computed(() => parse(props.source))
</script>

<template>
  <div class="space-y-1.5">
    <template v-for="(b, i) in blocks" :key="i">
      <!-- Heading -->
      <p v-if="b.k === 'h'" class="text-[11px] font-semibold uppercase tracking-wider text-[var(--c-text-3)] mt-3 first:mt-0">
        <template v-for="(t, j) in b.children" :key="j">
          <a v-if="t.t === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer" class="text-[var(--c-accent)] hover:underline">{{ t.v }}</a>
          <code v-else-if="t.t === 'code'" class="font-mono text-[0.95em] px-1 py-0.5 rounded bg-[var(--c-hover)] text-[var(--c-text-2)]">{{ t.v }}</code>
          <strong v-else-if="t.t === 'bold'" class="font-semibold text-[var(--c-text-2)]">{{ t.v }}</strong>
          <template v-else>{{ t.v }}</template>
        </template>
      </p>

      <!-- List item -->
      <div v-else-if="b.k === 'li'" class="flex gap-2 text-xs text-[var(--c-text-2)] leading-relaxed">
        <span class="text-[var(--c-text-3)] select-none mt-[3px]">•</span>
        <span>
          <template v-for="(t, j) in b.children" :key="j">
            <a v-if="t.t === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer" class="text-[var(--c-accent)] hover:underline">{{ t.v }}</a>
            <code v-else-if="t.t === 'code'" class="font-mono text-[0.95em] px-1 py-0.5 rounded bg-[var(--c-hover)] text-[var(--c-text-2)]">{{ t.v }}</code>
            <strong v-else-if="t.t === 'bold'" class="font-semibold text-[var(--c-text-1)]">{{ t.v }}</strong>
            <template v-else>{{ t.v }}</template>
          </template>
        </span>
      </div>

      <!-- Paragraph -->
      <p v-else class="text-xs text-[var(--c-text-2)] leading-relaxed">
        <template v-for="(t, j) in b.children" :key="j">
          <a v-if="t.t === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer" class="text-[var(--c-accent)] hover:underline">{{ t.v }}</a>
          <code v-else-if="t.t === 'code'" class="font-mono text-[0.95em] px-1 py-0.5 rounded bg-[var(--c-hover)] text-[var(--c-text-2)]">{{ t.v }}</code>
          <strong v-else-if="t.t === 'bold'" class="font-semibold text-[var(--c-text-2)]">{{ t.v }}</strong>
          <template v-else>{{ t.v }}</template>
        </template>
      </p>
    </template>
  </div>
</template>
