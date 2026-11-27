import { test } from 'node:test'
import assert from 'node:assert/strict'
import { poolRows, volumeType, storageFacts } from '../src/components/storage/storage-model.ts'

const leaf = (name: string, disk: string, state = 'ONLINE') => ({ name, type: 'disk', state, disk, read: 0, write: 0, checksum: 0, children: [] })
const raids = [
  { name: 'md0', level: 'raid1', state: 'clean', devices: ['/dev/sda', '/dev/sdb'], active: 2, total: 2 },
  { name: 'md1', level: 'raid5', state: 'active', devices: ['/dev/sdk', '/dev/sdl', '/dev/sdm'], active: 3, total: 3, resyncPercent: 40, syncAction: 'recovery' },
]
const devices = [{ name: 'md0', size: 4e12 }, { name: 'md1', size: 8e12 }] as any
const pvs = [{ name: '/dev/md0', vgName: 'data', size: 4e12, free: 1e12 }]
const vgs = [{ name: 'data', size: 4e12, free: 1e12, pvCount: 1, lvCount: 2 }]
const pools = [{ name: 'tank', guid: '1', state: 'DEGRADED', size: 8e12, alloc: 6e12, free: 2e12, frag: 0, scan: { kind: 'resilver', state: 'running', repaired: 0, errors: 0, percent: 43 },
  vdevs: [{ name: 'mirror-0', type: 'mirror', state: 'DEGRADED', read: 0, write: 0, checksum: 0, children: [leaf('/dev/sdc1', 'sdc'), leaf('/dev/sdd1', 'sdd', 'UNAVAIL')] }] }] as any
const datasets = [{ name: 'tank', pool: 'tank' }, { name: 'tank/a', pool: 'tank' }, { name: 'tank/b', pool: 'tank' }] as any

test('one list of pools of every type, with what each sits on and holds', () => {
  const rows = poolRows({ raids, devices, pvs, vgs, pools, datasets })
  assert.deepEqual(rows.map(r => [r.type, r.name]), [['md', 'md0'], ['md', 'md1'], ['lvm', 'data'], ['zfs', 'tank']])
  const md0 = rows[0]!
  assert.deepEqual([md0.layout, md0.size, md0.used, md0.health, md0.on, md0.holds], ['raid1', 4e12, null, 'ok', ['sda', 'sdb'], { kind: 'vg', name: 'data' }])
  assert.deepEqual(md0.location, { kind: 'array', name: 'md0' })
  const md1 = rows[1]!
  assert.deepEqual([md1.health, md1.progress, md1.holds], ['rebuilding', 40, null])
  const data = rows[2]!
  assert.deepEqual([data.layout, data.size, data.used, data.on, data.holds, data.location], ['vg', 4e12, 3e12, ['md0'], { kind: 'volumes', n: 2 }, { kind: 'vg', name: 'data' }])
  const tank = rows[3]!
  assert.deepEqual([tank.layout, tank.used, tank.health, tank.on, tank.holds, tank.progress], ['mirror', 6e12, 'degraded', ['sdc', 'sdd'], { kind: 'datasets', n: 3 }, 43])
})

test('a pool missing disks or failed reads as such', () => {
  const rows = poolRows({ raids: [{ name: 'md2', level: 'raid1', state: 'clean, degraded', devices: ['/dev/sdx'], active: 1, total: 2 }], devices: [], pvs: [], vgs: [], pools: [{ ...pools[0], state: 'FAULTED', scan: { kind: 'none', state: 'none', repaired: 0, errors: 0 } }], datasets: [] })
  assert.deepEqual(rows.map(r => r.health), ['degraded', 'failed'])
})

test('a volume says what type holds it', () => {
  const v = (stack: Array<{ kind: string; name: string }>, engine?: string) => ({ stack, engine }) as any
  assert.equal(volumeType(v([{ kind: 'filesystem', name: '/srv/x' }, { kind: 'lv', name: 'x' }, { kind: 'vg', name: 'data' }, { kind: 'array', name: 'md0' }])), 'lvm')
  assert.equal(volumeType(v([{ kind: 'filesystem', name: '/srv/x' }, { kind: 'array', name: 'md0' }, { kind: 'disk', name: 'sda' }])), 'md')
  assert.equal(volumeType(v([{ kind: 'dataset', name: 'tank/a' }], 'zfs')), 'zfs')
  assert.equal(volumeType(v([{ kind: 'filesystem', name: '/mnt/usb' }, { kind: 'partition', name: 'sdj1' }, { kind: 'disk', name: 'sdj' }])), 'plain')
})

test('the overview counts from disks to mounts and sums what pools offer', () => {
  const f = storageFacts({
    disks: [{ health: 'ok' }, { health: 'ok' }, { health: 'warning' }] as any,
    rows: poolRows({ raids, devices, pvs, vgs, pools, datasets }),
    volumes: [{ state: 'mounted', space: { total: 10, used: 4, free: 6 }, issues: [] }, { state: 'missing', issues: [{ kind: 'missing', text: 'x' }] }] as any,
  })
  assert.deepEqual([f.disks, f.healthyDisks, f.pools, f.volumes, f.mounted], [3, 2, 4, 2, 1])
  assert.deepEqual([f.capacity.total, f.capacity.used], [10 + 8e12, 4 + 6e12], 'the ZFS pool by its own size, the other volume by its filesystem')
  assert.deepEqual(f.running.map(r => r.name), ['md1', 'tank'], 'operations in progress, by pool')
})

test('a ZFS pool counts once in the capacity, whatever its datasets', () => {
  const zpool = { ...pools[0], state: 'ONLINE', size: 10, alloc: 3, scan: { kind: 'none', state: 'none', repaired: 0, errors: 0 } }
  const f = storageFacts({
    disks: [],
    rows: poolRows({ raids: [], devices: [], pvs: [], vgs: [], pools: [zpool], datasets: [] }),
    volumes: [
      { state: 'mounted', engine: 'zfs', space: { total: 8, used: 1, free: 7 }, issues: [] },
      { state: 'mounted', engine: 'zfs', space: { total: 9, used: 2, free: 7 }, issues: [] },
      { state: 'mounted', space: { total: 4, used: 1, free: 3 }, issues: [] },
    ] as any,
  })
  assert.deepEqual([f.capacity.total, f.capacity.used], [14, 4])
})

test('disks not read yet (asleep) are counted apart, not as unhealthy', () => {
  const f = storageFacts({ disks: [{ health: 'ok' }, { health: 'unknown' }, { health: 'warning' }] as any, rows: [], volumes: [] })
  assert.deepEqual([f.disks, f.checkedDisks, f.healthyDisks, f.uncheckedDisks], [3, 2, 1, 1])
})

test('a raidz being widened shows as in progress', () => {
  const p = { ...pools[0], state: 'ONLINE', scan: { kind: 'scrub', state: 'finished', repaired: 0, errors: 0 }, expand: { state: 'running', vdev: 'raidz1-0', pct: 37.5 } }
  const r = poolRows({ raids: [], devices: [], pvs: [], vgs: [], pools: [p], datasets: [] })[0]!
  assert.deepEqual([r.health, r.progress], ['rebuilding', 38])
})
