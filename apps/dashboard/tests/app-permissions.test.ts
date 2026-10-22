import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appPermissions, type PermissionSource } from '../src/lib/app-permissions.ts'

const empty = (): PermissionSource => ({ volumes: [], ports: [], env: [], restartPolicy: 'no' })

test('storage distinguishes read-only access from read and write access', () => {
  const app = empty()
  app.volumes = [
    { target: '/media', label: 'Media', readOnlyDefault: true },
    { target: '/config', label: 'Config', readOnlyDefault: false },
  ]
  assert.deepEqual(appPermissions(app), [
    { kind: 'Storage', title: 'Read Media', detail: '/media', note: 'Read-only' },
    { kind: 'Storage', title: 'Read and write Config', detail: '/config' },
  ])
})

test('network merges protocols for one port and identifies the web interface', () => {
  const app = empty()
  app.webUiPort = 3000
  app.ports = [
    { container: 53, protocol: 'tcp', label: 'DNS' },
    { container: 53, protocol: 'udp', label: 'DNS' },
    { container: 3000, protocol: 'tcp', label: 'Setup' },
  ]
  assert.deepEqual(appPermissions(app), [
    { kind: 'Network', title: 'Listens on DNS', detail: '53/tcp+udp' },
    { kind: 'Network', title: 'Listens on Setup', detail: '3000/tcp', note: 'Web interface' },
  ])
})

test('secrets use their prompts, falling back to keys, in one row', () => {
  const app = empty()
  app.env = [
    { key: 'TOKEN', prompt: 'Admin token', secret: true },
    { key: 'PASSWORD', secret: true },
    { key: 'TZ', prompt: 'Timezone', secret: false },
  ]
  assert.deepEqual(appPermissions(app), [
    { kind: 'Secret', title: 'Stores a secret', detail: 'Admin token, PASSWORD' },
  ])
  app.env = [{ key: 'TZ', secret: false }]
  assert.deepEqual(appPermissions(app), [])
})

test('startup is omitted for no restart policy; empty manifests have no permissions', () => {
  assert.deepEqual(appPermissions(empty()), [])
  assert.deepEqual(appPermissions({ ...empty(), restartPolicy: 'unless-stopped' }), [
    { kind: 'Startup', title: 'Starts with your server', detail: 'unless-stopped' },
  ])
})

test('permissions are ordered storage, network, secret, startup', () => {
  const app: PermissionSource = {
    volumes: [{ target: '/data', label: 'Data', readOnlyDefault: false }],
    ports: [{ container: 8080, protocol: 'tcp', label: 'HTTP' }],
    env: [{ key: 'TOKEN', secret: true }],
    restartPolicy: 'unless-stopped',
  }
  assert.deepEqual(appPermissions(app).map(p => p.kind), ['Storage', 'Network', 'Secret', 'Startup'])
})
