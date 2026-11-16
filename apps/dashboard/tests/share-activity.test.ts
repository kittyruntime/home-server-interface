import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapseRuns, groupByDay, machineLabel } from '../src/lib/share-activity.ts'

let n = 0
function ev(at: Date, over: Record<string, unknown> = {}) {
  return { id: String(++n), at, user: 'bob', share: 'Films', kind: 'auth', result: 'refused', reason: 'wrong_password', machine: 'PC', ip: '192.168.1.9', ...over }
}
const t0 = new Date(2026, 10, 16, 10, 0, 0)
const min = (m: number) => new Date(t0.getTime() - m * 60_000)

test('identical refusals in a row become one line with a count', () => {
  const runs = collapseRuns([ev(min(0)), ev(min(1)), ev(min(2))])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].count, 3)
  assert.equal(runs[0].latest.getTime(), min(0).getTime())
  assert.equal(runs[0].earliest.getTime(), min(2).getTime())
})

test('machine names differing only by case are the same machine', () => {
  const runs = collapseRuns([ev(min(0), { machine: 'pc' }), ev(min(1), { machine: 'PC' })])
  assert.equal(runs.length, 1)
})

test('a different reason, user or a long gap starts a new line', () => {
  assert.equal(collapseRuns([ev(min(0)), ev(min(1), { reason: 'unknown_user' })]).length, 2)
  assert.equal(collapseRuns([ev(min(0)), ev(min(1), { user: 'eve' })]).length, 2)
  assert.equal(collapseRuns([ev(min(0)), ev(min(30))]).length, 2)
})

test('a sign-in followed by opening a share from the same machine shows only the opening', () => {
  const connect = ev(min(0), { kind: 'connect', result: 'ok', reason: null, machine: 'pc' })
  const signIn = ev(new Date(min(0).getTime() - 2000), { kind: 'auth', result: 'ok', reason: null, share: null, machine: 'PC' })
  const runs = collapseRuns([connect, signIn])
  assert.deepEqual(runs.map(r => r.first.id), [connect.id])
})

test('a sign-in with no share opened after it stays', () => {
  const signIn = ev(min(0), { kind: 'auth', result: 'ok', reason: null, share: null })
  assert.equal(collapseRuns([signIn]).length, 1)
})

test('lines are grouped by local day, newest first, with today and yesterday named', () => {
  const now = new Date(2026, 10, 16, 18, 0).getTime()
  const days = groupByDay([
    ev(new Date(2026, 10, 16, 9, 0)), ev(new Date(2026, 10, 15, 23, 0), { user: 'a' }), ev(new Date(2026, 10, 9, 8, 0), { user: 'b' }),
  ].map(e => ({ first: e, count: 1, latest: e.at, earliest: e.at })), now, 'en')
  assert.deepEqual(days.map(d => d.label), ['Today', 'Yesterday', 'Monday, November 9'])
  assert.equal(days[0].runs.length, 1)
})

test('machine label is lowercase, falls back to the address', () => {
  assert.equal(machineLabel({ machine: 'THEO-PC', ip: '1.2.3.4' }), 'theo-pc')
  assert.equal(machineLabel({ machine: null, ip: '1.2.3.4' }), '1.2.3.4')
  assert.equal(machineLabel({ machine: '', ip: null }), '')
})
