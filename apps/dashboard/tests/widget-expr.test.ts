import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkExpression, evaluate, formatValue, levelOf, pathPart, readPath, segments } from '../src/lib/widget-expr.ts'

const jelly = [{ UserName: 'a', NowPlayingItem: { Name: 'X' } }, { UserName: 'b' }, { UserName: 'c', NowPlayingItem: { Name: 'Y' } }]
const stats = { photos: 1200, videos: 80, usage: 5e10, quota: 2e11, 'odd key': 3, items: [{ size: 10 }, { size: 32 }] }

test('paths read names, indexes and quoted keys', () => {
  assert.deepEqual(segments('a.b[2]["odd key"].c'), ['a', 'b', 2, 'odd key', 'c'])
  assert.equal(readPath(stats, '["odd key"]'), 3)
  assert.equal(readPath(stats, 'items.length'), 2)
  assert.equal(readPath(stats, 'constructor'), undefined)
  assert.equal(pathPart('odd key'), '["odd key"]')
  assert.equal(pathPart('photos'), '.photos')
  assert.equal(pathPart(3), '[3]')
})

test('a reference gives the raw value, arithmetic a number', () => {
  const scope = { sources: [stats, jelly] }
  assert.equal(evaluate('$1.photos', scope), 1200)
  assert.deepEqual(evaluate('$1.items[1]', scope), { size: 32 })
  assert.equal(evaluate('$1.usage / $1.quota * 100', scope), 25)
  assert.equal(evaluate('($1.photos + $1.videos) * 2', scope), 2560)
  assert.equal(evaluate('-$1.videos + 100', scope), 20)
  assert.equal(evaluate('count($2, "NowPlayingItem")', scope), 2)
  assert.equal(evaluate('count($2)', scope), 3)
  assert.equal(evaluate('sum($1.items, "size")', scope), 42)
  assert.equal(evaluate('max($1.items, "size") - min($1.items, "size")', scope), 22)
  assert.equal(evaluate('$1.photos / 0', scope), null, 'no division by zero')
  assert.equal(evaluate('$1.missing * 2', scope), null)
  assert.equal(evaluate('@.size * 2', { sources: [], item: { size: 4 } }), 8)
  assert.equal(evaluate('', scope), undefined)
})

test('expressions are arithmetic only', () => {
  assert.equal(checkExpression('$1.a + 2'), null)
  assert.match(checkExpression('alert(1)')!, /Unexpected/)
  assert.match(checkExpression('$1.a +')!, /end/)
  assert.match(checkExpression('$4.a')!, /Unexpected/)
  assert.match(checkExpression('constructor.constructor("x")()')!, /Unexpected/)
  assert.match(checkExpression('$1.a $1.b')!, /end/)
})

test('formats', () => {
  const o = { locale: 'en', now: Date.UTC(2026, 10, 20) }
  assert.equal(formatValue(1234.5, { ...o, format: 'number' }), '1,235')
  assert.equal(formatValue(12.345, { ...o, format: 'number', decimals: 2, unit: 'W' }), '12.35 W')
  assert.equal(formatValue(42, { ...o, format: 'percent' }), '42 %')
  assert.equal(formatValue(1536, { ...o, format: 'bytes' }), '1.5 KB')
  assert.equal(formatValue(2048, { ...o, format: 'bitrate' }), '2.0 KB/s')
  assert.equal(formatValue(3725, { ...o, format: 'duration' }), '1 h 2 min')
  assert.equal(formatValue('2026-11-19T00:00:00Z', { ...o, format: 'date' }), 'yesterday')
  assert.equal(formatValue('on', { ...o, format: 'bool', yes: 'Up', no: 'Down' }), 'Up')
  assert.equal(formatValue({ a: 1 }, { ...o, format: 'text' }), '{"a":1}')
  assert.equal(formatValue(null, { ...o, format: 'number' }), '-')
  assert.equal(formatValue('abc', { ...o, format: 'number' }), 'abc')
})

test('thresholds work upward and downward', () => {
  assert.equal(levelOf(95, '80', '90'), 'bad')
  assert.equal(levelOf(85, '80', '90'), 'warn')
  assert.equal(levelOf(10, '80', '90'), 'ok')
  assert.equal(levelOf(15, '30', '10', true), 'warn', 'battery: low is bad')
  assert.equal(levelOf(5, '30', '10', true), 'bad')
  assert.equal(levelOf(5, undefined, undefined), null)
  assert.equal(levelOf('x', '1', '2'), null)
})
