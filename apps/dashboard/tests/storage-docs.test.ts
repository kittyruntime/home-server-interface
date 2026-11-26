import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GUIDE_PAGES, TERM_ANCHORS, guideUrl, isDismissed } from '../src/lib/storage-docs.ts'

const DOCS = fileURLToPath(new URL('../../../website/src/content/docs/', import.meta.url))
// guide/features/storage/ -> <docs>/guide/features/storage.md
const markdownFor = (page: string) => `${DOCS}${page.replace(/\/$/, '')}.md`
const headings = (md: string) => md.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3).trim())
const slug = (h: string) => h.toLowerCase().replace(/\s+/g, '-')

test('every guide page exists', () => {
  for (const p of Object.values(GUIDE_PAGES)) assert.ok(existsSync(markdownFor(p)), p)
})

test('every term anchor is a glossary heading', () => {
  const slugs = headings(readFileSync(markdownFor(GUIDE_PAGES.glossary), 'utf8')).map(slug)
  for (const [term, a] of Object.entries(TERM_ANCHORS)) assert.ok(slugs.includes(a), `${term} -> #${a}`)
})

test('guideUrl builds absolute links', () => {
  assert.equal(guideUrl('glossary', 'scrub'), 'https://kittyruntime.github.io/home-server-interface/guide/features/storage-glossary/#scrub')
  assert.equal(guideUrl('lvm'), 'https://kittyruntime.github.io/home-server-interface/guide/features/storage-lvm/')
})

test('an intro dismissed by an older release stays dismissed', () => {
  assert.equal(isDismissed('lvm', { getItem: k => (k === 'lvm-intro-dismissed' ? '1' : null) }), true)
  assert.equal(isDismissed('disks', { getItem: () => null }), false)
  assert.equal(isDismissed('lvm', { getItem: () => { throw new Error('blocked') } }), false)
  assert.equal(isDismissed('lvm', () => { throw new Error('SecurityError: site data blocked') }), false, 'a storage that cannot even be reached counts as not dismissed')
})
