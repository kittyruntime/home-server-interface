import { test } from 'node:test'
import assert from 'node:assert/strict'
import { affectedDirs, folderChanges, announceFolderChanges } from '../src/lib/folder-changes.ts'

test('a move changes the folders it left and the one it entered', () => {
  assert.deepEqual(affectedDirs('move', ['/srv/a/x.zip', '/srv/a/y', '/srv/b/z'], '/srv/c').sort(), ['/srv/a', '/srv/b', '/srv/c'])
})

test('a copy only changes its destination', () => {
  assert.deepEqual(affectedDirs('copy', ['/srv/a/x.zip'], '/srv/c'), ['/srv/c'])
})

test('a file at the root has / as its folder', () => {
  assert.deepEqual(affectedDirs('move', ['/x'], '/srv').sort(), ['/', '/srv'])
})

test('every announcement is seen, even for the same folders', () => {
  const before = folderChanges.value.seq
  announceFolderChanges(['/srv/a'])
  announceFolderChanges(['/srv/a'])
  assert.equal(folderChanges.value.seq, before + 2)
  assert.deepEqual(folderChanges.value.dirs, ['/srv/a'])
})
