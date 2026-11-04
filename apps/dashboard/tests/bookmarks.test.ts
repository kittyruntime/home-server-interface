import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BOOKMARKS, bookmarkLabel, moveBookmark, normalizeBookmarks, placeFor, renameBookmark, toggleBookmark } from '../src/lib/bookmarks.ts'
import { normalizeFilePrefs } from '../src/lib/file-prefs.ts'

const paths = (l: { path: string }[]) => l.map(b => b.path)

test('toggling adds at the end, then removes', () => {
  const one = toggleBookmark([{ path: '/a' }], '/b')
  assert.deepEqual(paths(one), ['/a', '/b'])
  assert.deepEqual(paths(toggleBookmark(one, '/a')), ['/b'])
})

test('bad entries, duplicates and overflow are dropped', () => {
  const list = normalizeBookmarks([{ path: '/a' }, { path: '/a' }, { path: 'relative' }, null, { path: '/b', label: '  Films  ' }, 3])
  assert.deepEqual(list, [{ path: '/a' }, { path: '/b', label: 'Films' }])
  assert.equal(normalizeBookmarks(Array.from({ length: 60 }, (_, i) => ({ path: `/p${i}` }))).length, MAX_BOOKMARKS)
  assert.deepEqual(normalizeBookmarks('garbage'), [])
})

test('moving stops at both ends', () => {
  const list = [{ path: '/a' }, { path: '/b' }, { path: '/c' }]
  assert.deepEqual(paths(moveBookmark(list, '/c', -1)), ['/a', '/c', '/b'])
  assert.deepEqual(paths(moveBookmark(list, '/a', -1)), ['/a', '/b', '/c'])
  assert.deepEqual(paths(moveBookmark(list, '/c', 1)), ['/a', '/b', '/c'])
})

test('a label is optional, and an empty one goes back to the folder name', () => {
  assert.equal(bookmarkLabel({ path: '/srv/media/films/' }), 'films')
  assert.equal(bookmarkLabel({ path: '/' }), '/')
  const renamed = renameBookmark([{ path: '/srv/x', label: 'Old' }], '/srv/x', '  ')
  assert.deepEqual(renamed, [{ path: '/srv/x' }])
})

test('a bookmark opens in the place with the longest matching path', () => {
  const places = [{ id: 'root', path: '/' }, { id: 'media', path: '/srv/media' }, { id: 'm2', path: '/srv/media2' }]
  assert.equal(placeFor(places, '/srv/media/films')?.id, 'media')
  assert.equal(placeFor(places, '/srv/media2/a')?.id, 'm2')
  assert.equal(placeFor(places, '/etc')?.id, 'root')
  assert.equal(placeFor([{ id: 'media', path: '/srv/media' }], '/srv/other'), null)
})

test('display preferences keep bookmarks and drop broken ones', () => {
  assert.deepEqual(normalizeFilePrefs({ bookmarks: [{ path: '/a' }, { path: 'x' }] }).bookmarks, [{ path: '/a' }])
  assert.deepEqual(normalizeFilePrefs({}).bookmarks, [])
})
