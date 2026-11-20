import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultBoards, migrateLegacy, moveWidget } from '../src/lib/dashboard-boards.ts'
import { parseLinks } from '../src/components/widgets/links.ts'
import { toneOf } from '../src/components/widgets/kit/tone.ts'
import en from '../src/i18n/locales/en/widgets.ts'
import fr from '../src/i18n/locales/fr/widgets.ts'

const registry = readFileSync(join(import.meta.dirname, '../src/components/widgets/registry.ts'), 'utf8')
const types = [...registry.matchAll(/\{ type: '([a-z-]+)'/g)].map(m => m[1]!)
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

test('the former per-browser widgets move to their replacements', () => {
  const legacy = JSON.stringify([
    { id: 'w-cpu', type: 'cpu', cols: 1 },
    { id: 'w-ctr', type: 'containers', cols: 2 },
    { id: 'w-sys', type: 'sysinfo', cols: 1 },
    { id: 'w-st', type: 'storage', cols: 1 },
    { id: 'w-sm', type: 'smart', cols: 2 },
    { id: 'w-cpu2', type: 'cpu', cols: 2 },
  ])
  const out = migrateLegacy(legacy)!
  assert.deepEqual(out.map(w => [w.type, w.size]), [['cpu', 's'], ['apps', 'm'], ['volumes', 's'], ['disks', 'm']], 'System info is dropped, duplicates kept once')
  assert.equal(new Set(out.map(w => w.id)).size, out.length, 'fresh ids')
  assert.equal(migrateLegacy(null), null)
  assert.equal(migrateLegacy('not json'), null)
  assert.equal(migrateLegacy('{}'), null)
  for (const w of out) assert.ok(types.includes(w.type), `${w.type} is a known widget`)
})

test('the default board follows the role and what the viewer may read', () => {
  const admin = defaultBoards(true, () => true, 'Overview')
  assert.equal(admin.length, 1)
  assert.deepEqual(admin[0]!.widgets.slice(0, 3).map(w => w.type), ['alerts', 'cpu', 'memory'])
  const member = defaultBoards(false, t => !['alerts', 'volumes', 'backups', 'apps'].includes(t), 'Overview')
  assert.ok(member[0]!.widgets.every(w => !['alerts', 'volumes', 'backups', 'apps'].includes(w.type)))
  assert.ok(member[0]!.widgets.some(w => w.type === 'places'), 'a member starts from their own places')
  for (const w of [...admin[0]!.widgets, ...member[0]!.widgets]) assert.ok(types.includes(w.type), w.type)
})

test('moving a widget keeps every other in order', () => {
  assert.deepEqual(moveWidget(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveWidget(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(moveWidget(['a', 'b'], 1, 9), ['a', 'b'])
  const same = ['a']
  assert.equal(moveWidget(same, 0, 0), same)
  assert.equal(moveWidget(same, 5, 0), same)
})

test('links keep only web addresses, with a name', () => {
  assert.deepEqual(parseLinks([
    { label: 'Jellyfin', url: 'http://192.168.1.10:8096' },
    { label: '', url: 'https://cloud.example.org/' },
    { label: 'Bad', url: 'javascript:alert(1)' },
    { label: 'Files', url: 'file:///etc/passwd' },
    'junk',
  ]), [
    { label: 'Jellyfin', url: 'http://192.168.1.10:8096' },
    { label: 'cloud.example.org', url: 'https://cloud.example.org/' },
  ])
  assert.deepEqual(parseLinks(undefined), [])
  assert.equal(parseLinks(Array.from({ length: 40 }, (_, i) => ({ url: `http://h/${i}` }))).length, 24)
})

test('levels fill from warning to bad', () => {
  assert.equal(toneOf(10), 'ok')
  assert.equal(toneOf(75), 'warn')
  assert.equal(toneOf(95), 'bad')
  assert.equal(toneOf(85, 80, 92), 'warn')
})

test('every widget has a title and a description in each language', () => {
  assert.ok(types.length >= 20)
  assert.equal(new Set(types).size, types.length, 'one entry per type')
  for (const type of types) {
    const k = camel(type) as keyof typeof en.types
    for (const [lang, m] of [['en', en], ['fr', fr]] as const) {
      const entry = (m.types as Record<string, { title?: string; description?: string }>)[k]
      assert.ok(entry?.title && entry.description, `${lang}: widgets.types.${k}`)
    }
  }
  assert.deepEqual(Object.keys(fr.types).sort(), Object.keys(en.types).sort())
})
