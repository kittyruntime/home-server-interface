import { test } from 'node:test'
import assert from 'node:assert/strict'
import { occurrences, calendar, type Schedule } from '../src/components/storage/maintenance-calendar.ts'

// Local time, like the worker's schedule. 2026-11-25 is a Wednesday.
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h)
const s = (o: Partial<Schedule>): Schedule => ({ every: 'off', weekday: 0, day: 1, hour: 2, ...o })
const days = (list: Date[]) => list.map(d => `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}h`)

test('an off task never runs', () => {
  assert.deepEqual(occurrences(s({ every: 'off' }), at(2026, 11, 25, 12), 14), [])
})

test('a daily task runs every day at its hour', () => {
  const list = occurrences(s({ every: 'daily', hour: 2 }), at(2026, 11, 25), 14)
  assert.equal(list.length, 14)
  assert.ok(list.every(d => d.getHours() === 2))
})

test('a weekly task runs on its weekday (0 = Sunday)', () => {
  assert.deepEqual(days(occurrences(s({ every: 'weekly', weekday: 0 }), at(2026, 11, 25, 12), 14)), ['11-29 2h', '12-6 2h'])
})

test('a monthly task runs on its day of the month', () => {
  assert.deepEqual(days(occurrences(s({ every: 'monthly', day: 1, hour: 3 }), at(2026, 11, 25, 12), 14)), ['12-1 3h'])
})

test('a slot earlier today is past, a later one is still to come', () => {
  assert.deepEqual(days(occurrences(s({ every: 'daily', hour: 2 }), at(2026, 11, 25, 12), 1)), [])
  assert.deepEqual(days(occurrences(s({ every: 'daily', hour: 20 }), at(2026, 11, 25, 12), 1)), ['11-25 20h'])
})

test('the calendar has one entry per day, with every task of that day', () => {
  const cal = calendar({ smartShort: s({ every: 'weekly', weekday: 0 }), raidCheck: s({ every: 'weekly', weekday: 0, hour: 1 }) }, at(2026, 11, 25, 12), 14)
  assert.equal(cal.length, 14)
  assert.deepEqual(cal.find(c => c.date.getDate() === 29)!.tasks.sort(), ['raidCheck', 'smartShort'])
  assert.deepEqual(cal[0]!.tasks, [])
})
