import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterApps, summarizeApps } from '../src/lib/app-list.ts'

const apps = [
  { name: 'Jellyfin', status: 'running', pendingApply: false, app: { image: 'jellyfin/jellyfin:latest', ports: [{ hostPort: 8096, containerPort: 8096 }] } },
  { name: 'Vaultwarden', status: 'running', pendingApply: true, app: { image: 'vaultwarden/server:latest', ports: [{ hostPort: 8081, containerPort: 80 }] } },
  { name: 'Uptime Kuma', status: 'stopped', pendingApply: false, app: { image: 'louislam/uptime-kuma:1', ports: [{ hostPort: 3001, containerPort: 3001 }] } },
]

test('summarizeApps counts running, stopped and pending changes independently', () => {
  assert.deepEqual(summarizeApps(apps), { running: 2, stopped: 1, pending: 1 })
})

test('filterApps searches app names, images and published ports case-insensitively', () => {
  assert.deepEqual(filterApps(apps, 'VAULT'), [apps[1]])
  assert.deepEqual(filterApps(apps, 'uptime-kuma:1'), [apps[2]])
  assert.deepEqual(filterApps(apps, '8096'), [apps[0]])
  assert.equal(filterApps(apps, 'no match').length, 0)
})

test('filterApps supports compose apps without a single image', () => {
  const multiService = { name: 'Media Stack', status: 'running', app: null }
  assert.deepEqual(filterApps([multiService], 'media'), [multiService])
  assert.deepEqual(filterApps([multiService], 'nginx'), [])
})
