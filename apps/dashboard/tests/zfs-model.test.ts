import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diskRow } from '../src/components/storage/disk-list.ts'
import { chainOf } from '../src/components/storage/stack-chain.ts'
import { topology } from '../src/components/storage/zfs-topology.ts'

test('a disk whose partition is a ZFS member belongs to its pool', () => {
  const disk = { name: 'sdb', size: 4e12, type: 'disk', fstype: '', mountpoint: '', model: 'M', isSystem: false, isRemovable: false, usage: 'partitioned',
    children: [{ name: 'sdb1', size: 4e12, type: 'part', fstype: 'zfs_member', mountpoint: '', model: '', isSystem: false, isRemovable: false, usage: 'zfs-member', owner: 'tank' }] }
  const r = diskRow(disk)
  assert.equal(r.role, 'zfs')
  assert.deepEqual(r.poolOwners, ['tank'])
})

test('a dataset reads from its disks up to its folder', () => {
  const chain = chainOf({ fstype: 'zfs', mountPoint: '/tank/media', stack: [
    { kind: 'filesystem', name: '/tank/media' }, { kind: 'dataset', name: 'tank/media' }, { kind: 'pool', name: 'tank' },
    { kind: 'vdev', name: 'mirror-0' }, { kind: 'disk', name: 'sdb' }, { kind: 'disk', name: 'sda' },
  ] })
  assert.deepEqual(chain, [
    { kind: 'disks', names: ['sda', 'sdb'] },
    { kind: 'vdev', names: ['mirror-0'] },
    { kind: 'pool', names: ['tank'] },
    { kind: 'dataset', names: ['tank/media'] },
    { kind: 'mount', names: ['/tank/media'] },
  ])
})

const leaf = (disk: string, checksum = 0) => ({ name: `/dev/${disk}1`, type: 'disk', state: 'ONLINE', disk, read: 0, write: 0, checksum, children: [] })

test('the topology of a pool, row by row', () => {
  const rows = topology({ name: 'tank', state: 'DEGRADED', vdevs: [
    { name: 'mirror-0', type: 'mirror', state: 'DEGRADED', read: 0, write: 0, checksum: 0, children: [leaf('sda'), leaf('sdb', 12)] },
  ] })
  assert.deepEqual(rows.map(r => [r.label, r.kind, r.depth]), [['tank', 'pool', 0], ['mirror-0', 'vdev', 1], ['sda', 'disk', 2], ['sdb', 'disk', 2]])
  assert.equal(rows[3]!.errors, 12)
  assert.equal(rows[0]!.state, 'DEGRADED')
})

test('a pool layout in one line', async () => {
  const { layoutOf, scanLine } = await import('../src/components/storage/pool-summary.ts')
  const d = { type: 'disk', children: [] }
  assert.deepEqual(layoutOf([{ type: 'mirror', children: [d, d] }]), { kind: 'mirror', groups: 1, disks: 2 })
  assert.deepEqual(layoutOf([{ type: 'raidz2', children: [d, d, d, d] }, { type: 'raidz2', children: [d, d, d, d] }, { type: 'log', children: [d] }]), { kind: 'raidz2', groups: 2, disks: 8 })
  assert.deepEqual(layoutOf([d, d, d]), { kind: 'stripe', groups: 0, disks: 3 })
  assert.deepEqual(scanLine({ kind: 'none', state: 'none', errors: 0 }), { kind: 'never' })
  assert.deepEqual(scanLine({ kind: 'resilver', state: 'running', errors: 0, percent: 42.5 }), { kind: 'running', what: 'resilver', percent: 42.5 })
  assert.deepEqual(scanLine({ kind: 'scrub', state: 'finished', end: 'Sun Nov 22', errors: 3 }), { kind: 'done', what: 'scrub', end: 'Sun Nov 22', errors: 3 })
})

test('watched pools that are not imported', async () => {
  const { missingWatched } = await import('../src/components/storage/pool-summary.ts')
  const watched = [{ name: 'tank', guid: '1', datasets: [{ name: 'tank/a', mountPoint: '/tank/a' }] }, { name: 'old', guid: '2', datasets: [] }]
  assert.deepEqual(missingWatched(watched, [{ guid: '1' }]).map(w => w.name), ['old'])
  assert.deepEqual(missingWatched([], []), [])
})

test('usable capacity and failures tolerated of a new pool', async () => {
  const { poolCapacity } = await import('../src/components/storage/pool-summary.ts')
  const T = 1e12
  assert.deepEqual(poolCapacity('stripe', [4 * T, 2 * T]), { usable: 6 * T, tolerates: 0, enough: true })
  assert.deepEqual(poolCapacity('mirror', [4 * T, 2 * T]), { usable: 2 * T, tolerates: 1, enough: true })
  assert.deepEqual(poolCapacity('mirror', [4 * T, 4 * T, 4 * T]), { usable: 4 * T, tolerates: 2, enough: true })
  assert.deepEqual(poolCapacity('raidz1', [4 * T, 4 * T, 4 * T]), { usable: 8 * T, tolerates: 1, enough: true })
  assert.deepEqual(poolCapacity('raidz2', [4 * T, 4 * T, 4 * T, 3 * T]), { usable: 6 * T, tolerates: 2, enough: true })
  assert.deepEqual(poolCapacity('raidz3', [4 * T, 4 * T]), { usable: 0, tolerates: 3, enough: false })
  assert.equal(poolCapacity('mirror', [4 * T]).enough, false)
})
