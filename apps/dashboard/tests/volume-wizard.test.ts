import { test } from 'node:test'
import assert from 'node:assert/strict'
import { possibleLevels, usableBytes, tolerance, proposeName, mountFor } from '../src/components/storage/volume-wizard.ts'

test('only the levels the disk count allows', () => {
  assert.deepEqual(possibleLevels(1), ['none'])
  assert.deepEqual(possibleLevels(2), ['raid1', 'none'])
  assert.deepEqual(possibleLevels(3), ['raid1', 'raid5', 'none'])
  assert.deepEqual(possibleLevels(4), ['raid1', 'raid5', 'raid6', 'raid10', 'none'])
})

test('usable space and tolerance per level', () => {
  const four = [4e12, 4e12, 4e12, 3e12]
  assert.equal(usableBytes('none', four), 15e12)
  assert.equal(usableBytes('raid1', four), 3e12)
  assert.equal(usableBytes('raid5', four), 9e12)
  assert.equal(usableBytes('raid6', four), 6e12)
  assert.equal(usableBytes('raid10', four), 6e12)
  // mdadm raid10 (near=2) keeps two copies of every block: an odd count still
  // gives half the raw space.
  assert.equal(usableBytes('raid10', [3e12, 3e12, 3e12, 3e12, 3e12]), 7.5e12)
  assert.equal(tolerance('raid1', 3), 2)
  assert.equal(tolerance('raid5', 4), 1)
  assert.equal(tolerance('raid6', 4), 2)
  assert.equal(tolerance('none', 2), 0)
})

test('proposed names avoid what exists', () => {
  assert.equal(proposeName([], []), 'data')
  assert.equal(proposeName(['data'], []), 'data2')
  assert.equal(proposeName(['data'], ['/srv/data2']), 'data3')
  assert.equal(mountFor('media'), '/srv/media')
})
