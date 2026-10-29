import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogVersion, filterChips, isNew, keptFilter, matchesSearch, versionLabel, visibleApps, type StoreApp } from '../src/lib/store.ts'

const app = (name: string, category: string, extra: Partial<StoreApp> = {}): StoreApp => ({
  name, category, tagline: `${name} tagline`, description: `${name} description`, image: `x/${name.toLowerCase()}:1.0`, installedApp: null, ...extra,
})
const installed = { update: null }
const outdated = { update: { from: '1.0', to: '1.1' } }

const apps = [
  app('Jellyfin', 'Media'),
  app('Vaultwarden', 'Productivity', { installedApp: installed }),
  app('Navidrome', 'Media', { installedApp: outdated }),
  app('Syncthing', 'Utilities', { description: 'Peer-to-peer file sync' }),
]

test('filterChips counts installed apps, updates and each category', () => {
  assert.deepEqual(filterChips(apps), [
    { key: 'All', label: 'All', count: 4 },
    { key: 'Installed', label: 'Installed', count: 2 },
    { key: 'Updates', label: 'Updates', count: 1 },
    { key: 'Media', label: 'Media', count: 2 },
    { key: 'Productivity', label: 'Productivity', count: 1 },
    { key: 'Utilities', label: 'Utilities', count: 1 },
  ])
})

test('filterChips leaves out Installed and Updates when there are none', () => {
  assert.deepEqual(filterChips([app('Jellyfin', 'Media')]).map(c => c.key), ['All', 'Media'])
})

test('matchesSearch looks at the name, tagline, description and category, ignoring case', () => {
  const s = apps[3]!
  assert.equal(matchesSearch(s, 'SYNC'), true)
  assert.equal(matchesSearch(s, 'peer-to-peer'), true)
  assert.equal(matchesSearch(s, 'utilities'), true)
  assert.equal(matchesSearch(s, 'media'), false)
  assert.equal(matchesSearch(s, '  '), true)
})

test('visibleApps puts installed apps first in All, keeping the catalog order otherwise', () => {
  assert.deepEqual(visibleApps(apps, 'All', '').map(a => a.name), ['Vaultwarden', 'Navidrome', 'Jellyfin', 'Syncthing'])
})

test('visibleApps filters by installed, updates and category, then by search', () => {
  assert.deepEqual(visibleApps(apps, 'Installed', '').map(a => a.name), ['Vaultwarden', 'Navidrome'])
  assert.deepEqual(visibleApps(apps, 'Updates', '').map(a => a.name), ['Navidrome'])
  assert.deepEqual(visibleApps(apps, 'Media', '').map(a => a.name), ['Jellyfin', 'Navidrome'])
  assert.deepEqual(visibleApps(apps, 'Media', 'jelly').map(a => a.name), ['Jellyfin'])
})

test('catalogVersion is the image tag, or null for a digest or no tag', () => {
  assert.equal(catalogVersion('louislam/uptime-kuma:1.23.16'), '1.23.16')
  assert.equal(catalogVersion('registry:5000/app:v2'), 'v2')
  assert.equal(catalogVersion(`app@sha256:${'a'.repeat(64)}`), null)
  assert.equal(catalogVersion('registry:5000/app'), null)
})

test('keptFilter falls back to All once its chip is gone, so it never comes back by itself', () => {
  const chips = filterChips([app('Jellyfin', 'Media')])
  assert.equal(keptFilter(chips, 'Updates'), 'All')
  assert.equal(keptFilter(chips, 'Media'), 'Media')
})

test('versionLabel names the installed version, or the catalog one only for an app not installed', () => {
  const kuma = app('Kuma', 'Utilities', { image: 'louislam/uptime-kuma:1.23.16' })
  assert.equal(versionLabel(kuma), 'catalog 1.23.16')
  assert.equal(versionLabel({ ...kuma, installedApp: { update: null, image: 'louislam/uptime-kuma:1.23.15' } }), 'installed 1.23.15')
  // A viewer who is not an admin does not get the installed image: no version rather than a wrong one.
  assert.equal(versionLabel({ ...kuma, installedApp: { update: null, image: null } }), null)
})

test('visibleApps sorts by name or by the day apps joined the catalog', () => {
  const dated = [
    app('Syncthing', 'Utilities', { added: '2026-07-13' }),
    app('jellyfin', 'Media', { added: '2026-07-13' }),
    app('Paperless', 'Productivity', { added: '2026-10-28', installedApp: installed }),
  ]
  assert.deepEqual(visibleApps(dated, 'All', '', 'name').map(a => a.name), ['jellyfin', 'Paperless', 'Syncthing'], 'case does not matter')
  assert.deepEqual(visibleApps(dated, 'All', '', 'added').map(a => a.name), ['Paperless', 'jellyfin', 'Syncthing'], 'latest first, then by name')
  assert.deepEqual(visibleApps(dated, 'All', '').map(a => a.name), ['Paperless', 'Syncthing', 'jellyfin'], 'default: installed first, catalog order')
  assert.deepEqual(visibleApps(dated, 'Media', '', 'added').map(a => a.name), ['jellyfin'], 'the order keeps the filter')
})

test('isNew marks apps that joined the catalog in the last 60 days', () => {
  const now = new Date('2026-10-29T12:00:00Z')
  assert.equal(isNew(app('A', 'Media', { added: '2026-10-28' }), now), true)
  assert.equal(isNew(app('A', 'Media', { added: '2026-08-31' }), now), true)
  assert.equal(isNew(app('A', 'Media', { added: '2026-08-29' }), now), false)
  assert.equal(isNew(app('A', 'Media'), now), false, 'no date: not new')
  assert.equal(isNew(app('A', 'Media', { added: '2027-01-01' }), now), false, 'a date ahead of the clock is not trusted')
})
