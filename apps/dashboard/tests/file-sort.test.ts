import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceFor, extensionOf, headerSort, sortEntries, visibleEntries } from '../src/lib/file-sort.ts'
import { DEFAULT_FILE_PREFS, normalizeFilePrefs } from '../src/lib/file-prefs.ts'

const e = (name: string, type: 'dir' | 'file', size: number | null, day: number) =>
  ({ name, path: `/${name}`, type, size, mtime: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z` })

const entries = [
  e('b.txt', 'file', 30, 3), e('Photos', 'dir', null, 1), e('a.zip', 'file', 10, 5),
  e('.env', 'file', 1, 2), e('c.txt', 'file', 20, 4), e('Movies', 'dir', null, 6),
]
const names = (list: { name: string }[]) => list.map(x => x.name)

test('folders come first whatever the order', () => {
  assert.deepEqual(names(sortEntries(entries, { field: 'size', dir: 'desc' })).slice(0, 2), ['Movies', 'Photos'])
})

test('A-Z and Z-A sort by name', () => {
  assert.deepEqual(names(sortEntries(entries, { field: 'name', dir: 'asc' })), ['Movies', 'Photos', '.env', 'a.zip', 'b.txt', 'c.txt'])
  assert.deepEqual(names(sortEntries(entries, { field: 'name', dir: 'desc' })), ['Photos', 'Movies', 'c.txt', 'b.txt', 'a.zip', '.env'])
})

test('last modified puts the newest first, first modified the oldest', () => {
  assert.deepEqual(names(sortEntries(entries, { field: 'modified', dir: 'desc' })).slice(2), ['a.zip', 'c.txt', 'b.txt', '.env'])
  assert.deepEqual(names(sortEntries(entries, { field: 'modified', dir: 'asc' })).slice(2), ['.env', 'b.txt', 'c.txt', 'a.zip'])
})

test('type groups by extension, then by name', () => {
  assert.deepEqual(names(sortEntries(entries, { field: 'type', dir: 'asc' })).slice(2), ['.env', 'b.txt', 'c.txt', 'a.zip'])
})

test('names with numbers sort naturally', () => {
  const list = [e('file10', 'file', 1, 1), e('file2', 'file', 1, 1)]
  assert.deepEqual(names(sortEntries(list, { field: 'name', dir: 'asc' })), ['file2', 'file10'])
})

test('a leading dot is a hidden name, not an extension', () => {
  assert.equal(extensionOf('.env'), '')
  assert.equal(extensionOf('archive.TAR.GZ'), 'gz')
})

test('hidden files are left out unless shown', () => {
  assert.equal(visibleEntries(entries, false).some(x => x.name === '.env'), false)
  assert.equal(visibleEntries(entries, true).length, entries.length)
})

test('the menu shows the matching choice, size and type in either direction', () => {
  assert.equal(choiceFor({ field: 'modified', dir: 'desc' }), 'lastModified')
  assert.equal(choiceFor({ field: 'modified', dir: 'asc' }), 'firstModified')
  assert.equal(choiceFor({ field: 'size', dir: 'asc' }), 'size')
  assert.equal(choiceFor({ field: 'type', dir: 'desc' }), 'type')
})

test('a header click flips the same field and starts another from its natural direction', () => {
  assert.deepEqual(headerSort({ field: 'name', dir: 'asc' }, 'name'), { field: 'name', dir: 'desc' })
  assert.deepEqual(headerSort({ field: 'name', dir: 'asc' }, 'size'), { field: 'size', dir: 'desc' })
  assert.deepEqual(headerSort({ field: 'size', dir: 'desc' }, 'type'), { field: 'type', dir: 'asc' })
})

test('display preferences fall back field by field', () => {
  assert.deepEqual(normalizeFilePrefs(null), DEFAULT_FILE_PREFS)
  const p = normalizeFilePrefs({ sortField: 'colour', sortDir: 'desc', columns: ['type', 'owner', 'size'], showHidden: 'yes', view: 'grid' })
  assert.equal(p.sortField, 'name')
  assert.equal(p.sortDir, 'desc')
  assert.deepEqual(p.columns, ['size', 'type'])
  assert.equal(p.showHidden, false)
  assert.equal(p.view, 'grid')
})
