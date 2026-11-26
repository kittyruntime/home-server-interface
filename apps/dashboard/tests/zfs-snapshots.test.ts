import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byDataset, snapKind, crumbs, joinPath } from '../src/components/storage/snapshot-model.ts'

const s = (name: string, created: number, used = 0) => {
  const [dataset, short] = name.split('@')
  return { name, dataset, short, created, used, refer: 0 }
}

test('snapshots grouped by dataset, newest first, with the space they hold', () => {
  const g = byDataset([s('tank/a@x', 1, 10), s('tank/b@y', 5), s('tank/a@z', 3, 5)], ['tank/a', 'tank/b', 'tank/c'])
  assert.deepEqual(g.map(x => [x.dataset, x.snaps.map(y => y.short), x.used]), [['tank/a', ['z', 'x'], 15], ['tank/b', ['y'], 0], ['tank/c', [], 0]])
})

test('what made a snapshot', () => {
  assert.equal(snapKind('hsi-manual-20261126-100507'), 'manual')
  assert.equal(snapKind('hsi-daily-20261126-0300'), 'daily')
  assert.equal(snapKind('hsi-monthly-20261101-0300'), 'monthly')
  assert.equal(snapKind('autosnap_2026'), 'other')
  assert.equal(snapKind('hsi-yearly-1'), 'other')
})

test('a path inside a snapshot as breadcrumbs', () => {
  assert.deepEqual(crumbs(''), [])
  assert.deepEqual(crumbs('a/b'), [{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }])
  assert.equal(joinPath('', 'x'), 'x')
  assert.equal(joinPath('a/b', 'x'), 'a/b/x')
})
