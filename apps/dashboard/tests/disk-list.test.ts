import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  diskRow, summarize, filterRows, sortRows, groupRows, isSelectable, type ListDev,
} from '../src/components/storage/disk-list.ts'

const GB = 1_000_000_000

function disk(name: string, extra: Partial<ListDev> = {}): ListDev {
  return {
    name, size: 1000 * GB, type: 'disk', fstype: '', mountpoint: '', model: 'WDC WD10', serial: `S-${name}`,
    isSystem: false, isRemovable: false, usage: 'free', children: [], ...extra,
  }
}

function part(name: string, extra: Partial<ListDev> = {}): ListDev {
  return { ...disk(name), type: 'part', model: '', serial: undefined, usage: 'filesystem', ...extra }
}

const system = disk('sda', { isSystem: true, usage: 'system', children: [part('sda1', { mountpoint: '/', usage: 'system' })] })
const raidA  = disk('sdb', { usage: 'partitioned', children: [part('sdb1', { usage: 'raid-member', owner: 'md0' })] })
const raidB  = disk('sdc', { usage: 'raid-member', owner: 'md0' })
const pv     = disk('sdd', { usage: 'lvm-pv', owner: 'data' })
const media  = disk('sde', { usage: 'partitioned', children: [part('sde1', { mountpoint: '/mnt/media', usage: 'mounted' })] })
const blank  = disk('sdf', { model: 'Samsung SSD', serial: 'XYZ123' })
const unused = disk('sdg', { usage: 'partitioned', children: [part('sdg1', { fstype: 'ext4' })] })

test('roles come from the disk and everything on it', () => {
  assert.equal(diskRow(system).role, 'system')
  assert.equal(diskRow(raidA).role, 'raid')
  assert.deepEqual(diskRow(raidA).raidOwners, ['md0'])
  assert.equal(diskRow(raidB).role, 'raid')
  assert.equal(diskRow(pv).role, 'lvm')
  assert.deepEqual(diskRow(pv).vgOwners, ['data'])
  assert.equal(diskRow(media).role, 'mounted')
  assert.equal(diskRow(blank).role, 'free')
  assert.equal(diskRow(unused).role, 'unmounted')
})

test('a member of an inactive array is still a RAID member, with no owner', () => {
  const r = diskRow(disk('sdh', { usage: undefined, fstype: 'linux_raid_member' }))
  assert.equal(r.role, 'raid')
  assert.deepEqual(r.raidOwners, [])
})

test('an LVM volume group on top of an array is listed as an owner', () => {
  const md = { ...disk('md0'), type: 'raid1', usage: 'lvm-pv', owner: 'vg1' }
  const r = diskRow(disk('sdi', { usage: 'raid-member', owner: 'md0', children: [md] }))
  assert.equal(r.role, 'raid')
  assert.deepEqual(r.raidOwners, ['md0'])
  assert.deepEqual(r.vgOwners, ['vg1'])
})

test('disk kind uses the name, removable flag and rotation rate', () => {
  assert.equal(diskRow(disk('nvme0n1')).kind, 'NVMe')
  assert.equal(diskRow(disk('sdj', { isRemovable: true })).kind, 'USB')
  assert.equal(diskRow(blank, { health: 'passed', available: true, rotationRate: 0 }).kind, 'SSD')
  assert.equal(diskRow(blank, { health: 'passed', available: true, rotationRate: 7200 }).kind, 'HDD')
  assert.equal(diskRow(blank).kind, '')
})

const rows = [
  diskRow(system, { health: 'passed' }),
  diskRow(raidA,  { health: 'warning', temperature: 45 }),
  diskRow(raidB,  { health: 'passed', temperature: 38 }),
  diskRow(pv,     { health: 'failed' }),
  diskRow(media),
  diskRow(blank,  { health: 'passed' }),
  diskRow(unused),
]

test('summary counts roles, health and capacity', () => {
  const s = summarize(rows)
  assert.equal(s.disks, 7)
  assert.equal(s.totalBytes, 7000 * GB)
  assert.equal(s.freeBytes, 1000 * GB)
  assert.equal(s.roles.raid, 2)
  assert.equal(s.roles.free, 1)
  assert.equal(s.health.warning, 1)
  assert.equal(s.health.failed, 1)
  assert.equal(s.health.unknown, 2)
})

test('filters by role, health and search terms', () => {
  assert.deepEqual(filterRows(rows, { role: 'raid' }).map(r => r.disk.name), ['sdb', 'sdc'])
  assert.deepEqual(filterRows(rows, { health: 'failed' }).map(r => r.disk.name), ['sdd'])
  // Model, serial, partition name, owner and mount point are all searchable.
  assert.deepEqual(filterRows(rows, { search: 'samsung' }).map(r => r.disk.name), ['sdf'])
  assert.deepEqual(filterRows(rows, { search: 'xyz123' }).map(r => r.disk.name), ['sdf'])
  assert.deepEqual(filterRows(rows, { search: '/dev/sdb1' }).map(r => r.disk.name), ['sdb'])
  assert.deepEqual(filterRows(rows, { search: 'md0' }).map(r => r.disk.name), ['sdb', 'sdc'])
  assert.deepEqual(filterRows(rows, { search: 'media' }).map(r => r.disk.name), ['sde'])
  assert.deepEqual(filterRows(rows, { search: 'md0', health: 'passed' }).map(r => r.disk.name), ['sdc'])
})

test('sorts naturally by name and falls back to the name on ties', () => {
  const named = ['sdaa', 'sdb', 'nvme10n1', 'nvme2n1', 'sda'].map(n => diskRow(disk(n)))
  assert.deepEqual(sortRows(named, 'name', 'asc').map(r => r.disk.name), ['nvme2n1', 'nvme10n1', 'sda', 'sdaa', 'sdb'])
  assert.deepEqual(sortRows(rows, 'health', 'asc').map(r => r.disk.name).slice(0, 2), ['sdd', 'sdb'])
  assert.deepEqual(sortRows(rows, 'temperature', 'desc').map(r => r.disk.name).slice(0, 2), ['sdb', 'sdc'])
})

test('groups array and volume group members together', () => {
  const groups = groupRows(rows)
  assert.deepEqual(groups.map(g => g.label), ['System', 'RAID md0', 'Volume group data', 'Mounted', 'Not mounted', 'Free'])
  assert.deepEqual(groups[1]!.rows.map(r => r.disk.name), ['sdb', 'sdc'])
})

test('only free, non-system whole disks can be selected', () => {
  assert.deepEqual(rows.filter(isSelectable).map(r => r.disk.name), ['sdf'])
})
