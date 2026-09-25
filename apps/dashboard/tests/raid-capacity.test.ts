import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raidCapacity, remainingFaultTolerance } from '../src/components/storage/raid-capacity.ts'

const TB = 1_000_000_000_000

test('RAID 1 keeps one copy of the smallest disk', () => {
  const c = raidCapacity(1, [4 * TB, 4 * TB])
  assert.equal(c.usable, 4 * TB)
  assert.equal(c.efficiency, 50)
  assert.equal(c.faultTolerance, 1)
})

test('RAID 5 loses one disk to parity', () => {
  const c = raidCapacity('raid5', [2 * TB, 2 * TB, 2 * TB])
  assert.equal(c.usable, 4 * TB)
  assert.equal(c.efficiency, 67)
})

test('RAID 6 loses two disks to parity', () => {
  assert.equal(raidCapacity('raid6', [TB, TB, TB, TB]).usable, 2 * TB)
})

test('RAID 10 keeps half, survives one failure per mirror pair', () => {
  const c = raidCapacity(10, [TB, TB, TB, TB])
  assert.equal(c.usable, 2 * TB)
  assert.equal(c.faultTolerance, 1)
  assert.equal(c.maxFaultTolerance, 2)
})

test('RAID 0 uses every disk and tolerates nothing', () => {
  const c = raidCapacity(0, [TB, 2 * TB])
  assert.equal(c.usable, 3 * TB)
  assert.equal(c.faultTolerance, 0)
  assert.deepEqual(c.wasted, [0, 0])
})

test('mixed sizes waste the difference on larger disks', () => {
  const c = raidCapacity(1, [2 * TB, 3 * TB])
  assert.equal(c.usable, 2 * TB)
  assert.deepEqual(c.wasted, [0, TB])
})

test('below the minimum device count nothing is computed', () => {
  const c = raidCapacity(5, [TB, TB])
  assert.equal(c.valid, false)
  assert.equal(c.minDevices, 3)
  assert.equal(c.usable, 0)
})

test('remaining fault tolerance drops as members fail', () => {
  assert.equal(remainingFaultTolerance('raid5', 3, 3), 1)
  assert.equal(remainingFaultTolerance('raid5', 3, 2), 0)
  assert.equal(remainingFaultTolerance('raid1', 3, 2), 1)
  assert.equal(remainingFaultTolerance('raid0', 2, 2), 0)
})
