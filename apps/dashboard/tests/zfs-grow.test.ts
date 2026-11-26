import { test } from 'node:test'
import assert from 'node:assert/strict'
import { growOptions } from '../src/components/storage/grow-model.ts'

const leaf = (name: string, type = 'disk') => ({ name, type, state: 'ONLINE', read: 0, write: 0, checksum: 0, children: [] })
const group = (name: string, type: string, n: number) => ({ name, type, state: 'ONLINE', read: 0, write: 0, checksum: 0, children: Array.from({ length: n }, (_, i) => leaf(`/dev/${name}-${i}`)) })

test('a mirror pool takes groups of its width and a copy per group', () => {
  const g = growOptions({ vdevs: [group('mirror-0', 'mirror', 2), leaf('/dev/log', 'log')], expandSize: 0 }, '2.2.2')
  assert.deepEqual(g, { layout: 'mirror', width: 2, attach: [{ vdev: 'mirror-0', kind: 'mirror' }], expand: false })
})

test('a raidz is widened only from OpenZFS 2.3', () => {
  const p = { vdevs: [group('raidz1-0', 'raidz1', 3)], expandSize: 5e9 }
  assert.deepEqual(growOptions(p, '2.3.1').attach, [{ vdev: 'raidz1-0', kind: 'raidz' }])
  assert.deepEqual(growOptions(p, '2.2.6').attach, [])
  assert.equal(growOptions(p, '2.2.6').expand, true)
})

test('a pool mixing layouts cannot take a group', () => {
  const g = growOptions({ vdevs: [group('mirror-0', 'mirror', 2), group('raidz1-1', 'raidz1', 3)], expandSize: 0 }, '2.3.0')
  assert.equal(g.layout, null)
})

test('a single disk pool takes more disks without redundancy', () => {
  const g = growOptions({ vdevs: [leaf('/dev/sdf1')], expandSize: 0 }, '2.2.0')
  assert.equal(g.layout, 'stripe')
  assert.equal(g.width, 1)
  assert.deepEqual(g.attach, [])
})
