import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressAfter, expiryState, modeLabel, waitForServer } from '../src/lib/tls.ts'

test('modeLabel names each mode', () => {
  assert.equal(modeLabel('local'), 'HTTPS, local authority')
  assert.equal(modeLabel('off'), 'Plain HTTP')
})

test('expiryState warns under 30 days and after expiry', () => {
  const now = new Date('2026-10-13T00:00:00Z')
  assert.deepEqual(expiryState('2027-01-01T00:00:00Z', now), { level: 'ok', days: 80 })
  assert.deepEqual(expiryState('2026-10-23T00:00:00Z', now), { level: 'soon', days: 10 })
  assert.equal(expiryState('2026-10-12T00:00:00Z', now).level, 'expired')
})

test('addressAfter keeps the host and path and moves scheme and port', () => {
  const loc = { protocol: 'http:', hostname: '192.168.1.48', port: '9001', pathname: '/' }
  assert.equal(addressAfter(loc, { https: true, port: 9001, standardPorts: false }), 'https://192.168.1.48:9001/')
  assert.equal(addressAfter({ ...loc, protocol: 'https:' }, { https: true, port: 9001, standardPorts: true }), 'https://192.168.1.48/')
  assert.equal(addressAfter({ ...loc, protocol: 'https:' }, { https: false, port: 9001, standardPorts: false }), 'http://192.168.1.48:9001/')
  assert.equal(addressAfter({ protocol: 'http:', hostname: 'nas', port: '', pathname: '/' }, { https: false, port: 9001, standardPorts: false }), 'http://nas/', 'behind a proxy on 80: stay where the page is')
})

test('addressAfter goes to the HSI port when leaving HTTPS served by HSI itself', () => {
  const next = { https: false, port: 9001, standardPorts: false }
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas', port: '', pathname: '/' }, next), 'http://nas:9001/')
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas', port: '9001', pathname: '/' }, next), 'http://nas:9001/')
})

function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    at: () => t,
  }
}

test('waitForServer waits before the first poll', async () => {
  const c = clock()
  let firstAt = -1
  const fetchFn = async () => { firstAt = c.at(); return {} as Response }
  await waitForServer('http://nas:9001', 60_000, { now: c.now, sleep: c.sleep, fetch: fetchFn })
  assert.equal(firstAt, 3000)
})

test('waitForServer keeps polling an http origin past 8 s', async () => {
  const c = clock()
  let calls = 0
  const fetchFn = async () => { calls++; if (c.at() < 20_000) throw new Error('down'); return {} as Response }
  await waitForServer('http://nas:9001', 60_000, { now: c.now, sleep: c.sleep, fetch: fetchFn })
  assert.ok(c.at() >= 20_000 && c.at() < 25_000)
  assert.ok(calls > 5)
})

test('waitForServer gives up on an https origin after 8 s', async () => {
  const c = clock()
  const fetchFn = async () => { throw new Error('untrusted') }
  await waitForServer('https://nas', 60_000, { now: c.now, sleep: c.sleep, fetch: fetchFn })
  assert.ok(c.at() >= 8000 && c.at() < 10_000)
})
