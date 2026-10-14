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
  assert.equal(addressAfter(loc, { from: 'off', https: true, port: 9001, standardPorts: false }), 'https://192.168.1.48:9001/')
  assert.equal(addressAfter({ ...loc, protocol: 'https:' }, { from: 'local', https: true, port: 9001, standardPorts: true }), 'https://192.168.1.48/')
  assert.equal(addressAfter({ ...loc, protocol: 'https:' }, { from: 'local', https: false, port: 9001, standardPorts: false }), 'http://192.168.1.48:9001/')
  assert.equal(addressAfter({ protocol: 'http:', hostname: 'nas', port: '', pathname: '/' }, { from: 'proxy', https: false, port: 9001, standardPorts: false }), 'http://nas/', 'behind a proxy on 80: stay where the page is')
})

test('addressAfter goes to the HSI port when leaving HTTPS served by HSI itself', () => {
  const next = { from: 'local' as const, https: false, port: 9001, standardPorts: false }
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas', port: '', pathname: '/' }, next), 'http://nas:9001/')
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas', port: '9001', pathname: '/' }, next), 'http://nas:9001/')
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas', port: '9001', pathname: '/' }, { ...next, from: 'imported' }), 'http://nas:9001/')
})

test('addressAfter stays on the proxy origin when the mode stays proxy', () => {
  const next = { from: 'proxy' as const, https: false, port: 9001, standardPorts: false }
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas.example.com', port: '', pathname: '/settings' }, next), 'https://nas.example.com/settings')
  assert.equal(addressAfter({ protocol: 'https:', hostname: 'nas.example.com', port: '8443', pathname: '/' }, next), 'https://nas.example.com:8443/')
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
  await waitForServer('http://nas:9001', 60_000, { now: c.now, sleep: c.sleep, fetch: fetchFn, pageProtocol: 'http:' })
  assert.equal(firstAt, 3000)
})

test('waitForServer keeps polling an http origin past 8 s', async () => {
  const c = clock()
  let calls = 0
  const fetchFn = async () => { calls++; if (c.at() < 20_000) throw new Error('down'); return {} as Response }
  await waitForServer('http://nas:9001', 60_000, { now: c.now, sleep: c.sleep, fetch: fetchFn, pageProtocol: 'http:' })
  assert.ok(c.at() >= 20_000 && c.at() < 25_000)
  assert.ok(calls > 5)
})

test('waitForServer probes an https target over plain http on the same port and waits for the redirect', async () => {
  const c = clock()
  const seen: Array<{ url: string; init: RequestInit; at: number }> = []
  const fetchFn = async (url: string, init: RequestInit) => {
    seen.push({ url, init, at: c.at() })
    if (c.at() < 6_000) throw new Error('down')
    if (c.at() < 12_000) return { type: 'opaque' } // the old plain HTTP server still answers
    return { type: 'opaqueredirect' }
  }
  await waitForServer('https://nas:9001', 60_000, { now: c.now, sleep: c.sleep, fetch: fetchFn, pageProtocol: 'http:' })
  assert.equal(seen[0]!.at, 3000)
  assert.equal(seen[0]!.url, 'http://nas:9001/health')
  assert.equal(seen[0]!.init.redirect, 'manual')
  assert.equal(seen[0]!.init.mode, 'no-cors')
  assert.ok(c.at() >= 12_000 && c.at() < 14_000, `resolved at ${c.at()}`)
})

test('waitForServer probes port 443 for an https target on the standard port', async () => {
  const c = clock()
  const urls: string[] = []
  await waitForServer('https://nas', 60_000, { now: c.now, sleep: c.sleep, pageProtocol: 'http:', fetch: async (url: string) => { urls.push(url); return { type: 'opaqueredirect' } } })
  assert.deepEqual(urls, ['http://nas:443/health'])
})

test('waitForServer keeps probing an https target that never comes back until the timeout', async () => {
  const c = clock()
  await waitForServer('https://nas:9001', 30_000, { now: c.now, sleep: c.sleep, pageProtocol: 'http:', fetch: async () => { throw new Error('down') } })
  assert.ok(c.at() >= 30_000 && c.at() < 32_000, `gave up at ${c.at()}`)
})

test('waitForServer from an https page to an http target waits a fixed grace without fetching', async () => {
  const c = clock()
  let calls = 0
  await waitForServer('http://nas:9001', 60_000, { now: c.now, sleep: c.sleep, pageProtocol: 'https:', fetch: async () => { calls++; return {} } })
  assert.equal(calls, 0)
  assert.equal(c.at(), 10_000)
})

test('waitForServer from an https page polls an https target directly (proxy to proxy)', async () => {
  const c = clock()
  const urls: string[] = []
  await waitForServer('https://nas.example.com', 60_000, { now: c.now, sleep: c.sleep, pageProtocol: 'https:', fetch: async (url: string) => { urls.push(url); return {} } })
  assert.deepEqual(urls, ['https://nas.example.com/health'])
  assert.equal(c.at(), 3000)
})

test('openAfterRestart waits for the new origin then navigates to the new address', async () => {
  const { openAfterRestart } = await import('../src/lib/tls.ts')
  const calls: string[] = []
  await openAfterRestart(
    { protocol: 'http:', hostname: 'nas', port: '3000', pathname: '/setup' },
    { from: 'off', https: true, port: 8443, standardPorts: false },
    { wait: async o => { calls.push(`wait ${o}`) }, assign: u => { calls.push(`go ${u}`) } },
  )
  assert.deepEqual(calls, ['wait https://nas:8443', 'go https://nas:8443/setup'])
})

test('openAfterRestart behind an https proxy stays on the same origin', async () => {
  const { openAfterRestart } = await import('../src/lib/tls.ts')
  const calls: string[] = []
  await openAfterRestart(
    { protocol: 'https:', hostname: 'nas.example.com', port: '', pathname: '/settings' },
    { from: 'proxy', https: false, port: 9001, standardPorts: false },
    { wait: async o => { calls.push(`wait ${o}`) }, assign: u => { calls.push(`go ${u}`) } },
  )
  assert.deepEqual(calls, ['wait https://nas.example.com', 'go https://nas.example.com/settings'])
})
