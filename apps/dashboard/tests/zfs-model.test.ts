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
