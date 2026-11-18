import { test } from 'node:test'
import assert from 'node:assert/strict'
import { niceMax, pushSample, sortProcesses, matchesProcess, heat } from '../src/lib/perf-math.ts'

test('the chart scale rounds up to a readable value', () => {
  assert.equal(niceMax([0, 0]), 1024, 'an idle rate still gets a scale')
  assert.equal(niceMax([3_000]), 5_000)
  assert.equal(niceMax([12_000_000]), 20_000_000)
  assert.equal(niceMax([999]), 1024, 'never below the floor')
  assert.equal(niceMax([150_000_000]), 200_000_000)
  assert.equal(niceMax([7], 1), 10)
})

test('history keeps the last samples only', () => {
  const h: number[] = []
  for (let i = 0; i < 65; i++) pushSample(h, i, 60)
  assert.equal(h.length, 60)
  assert.equal(h[0], 5)
  assert.equal(h[59], 64)
})

const p = (pid: number, name: string, cpu: number, rss: number, user = 'root', cmd = '') =>
  ({ pid, name, cpu, rss, user, cmd, readBps: 0, writeBps: 0 })

test('processes sort by any column, ties by pid', () => {
  const list = [p(3, 'b', 5, 10), p(1, 'a', 5, 30), p(2, 'C', 9, 20)]
  assert.deepEqual(sortProcesses(list, 'cpu', 'desc').map(x => x.pid), [2, 1, 3])
  assert.deepEqual(sortProcesses(list, 'name', 'asc').map(x => x.pid), [1, 3, 2], 'names ignore case')
  assert.deepEqual(sortProcesses(list, 'rss', 'asc').map(x => x.pid), [3, 2, 1])
  assert.deepEqual(list.map(x => x.pid), [3, 1, 2], 'the input is left alone')
})

test('search matches name, command, user or pid', () => {
  const x = p(812, 'smbd', 0, 0, 'camille', '/usr/sbin/smbd --foreground')
  assert.ok(matchesProcess(x, 'SMB'))
  assert.ok(matchesProcess(x, 'foreground'))
  assert.ok(matchesProcess(x, 'cami'))
  assert.ok(matchesProcess(x, '812'))
  assert.ok(matchesProcess(x, '  '))
  assert.ok(!matchesProcess(x, 'nginx'))
})

test('heat grows with the share of the machine', () => {
  assert.equal(heat(0), 0)
  assert.equal(heat(100), 4)
  assert.equal(heat(3), 1)
  assert.equal(heat(30), 3)
})

test('readable uptime, rate and clock speed', async () => {
  const { fmtUptime, fmtRate, fmtGhz } = await import('../src/lib/perf-math.ts')
  assert.equal(fmtUptime(4 * 86400 + 3 * 3600 + 12 * 60 + 5), '4:03:12:05')
  assert.equal(fmtUptime(59), '0:00:00:59')
  assert.equal(fmtRate(0), '0 B/s')
  assert.equal(fmtRate(1536), '1.5 KB/s')
  assert.equal(fmtGhz(2400), '2.40 GHz')
  assert.equal(fmtGhz(0), '-')
})

test('a rate scale lands on round binary units', async () => {
  const { niceBytes } = await import('../src/lib/perf-math.ts')
  const MB = 1024 ** 2
  assert.equal(niceBytes([0]), 1024, 'an idle link still gets a scale')
  assert.equal(niceBytes([9.6 * MB]), 10 * MB)
  assert.equal(niceBytes([40 * MB, 3 * MB]), 50 * MB)
  assert.equal(niceBytes([700 * 1024]), 1000 * 1024)
  assert.equal(niceBytes([1.5 * 1024 ** 3]), 2 * 1024 ** 3)
})
