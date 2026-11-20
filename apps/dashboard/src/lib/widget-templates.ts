import type { CustomConfig } from './widget-custom'

// Ready-made sources: the address and header of a known app's API, or one of
// the server's read-only commands, with a widget to show it. A template whose
// app is installed takes the app's port; the server reaches it on 127.0.0.1.

export interface SourceTemplate {
  id: string
  /** App names (as installed from the App Store) this template is for. */
  apps?: string[]
  kind: 'http' | 'command'
  port?: number
  path?: string
  command?: string
  header?: { name: string; prefix?: string }
  intervalSec: number
  trackPath?: string
  widget: Partial<CustomConfig>
}

export const TEMPLATES: SourceTemplate[] = [
  {
    id: 'jellyfin', apps: ['jellyfin'], kind: 'http', port: 8096, path: '/Sessions?activeWithinSeconds=120',
    header: { name: 'X-Emby-Token' }, intervalSec: 60,
    widget: { display: 'list', value: 'count($1, "NowPlayingItem")', format: 'number', list: { path: '$1', label: '@.UserName', value: '@.NowPlayingItem.Name' } },
  },
  {
    id: 'immich', apps: ['immich', 'immich-server'], kind: 'http', port: 2283, path: '/api/server/statistics',
    header: { name: 'x-api-key' }, intervalSec: 600, trackPath: 'usage',
    widget: { display: 'chart', value: '$1.photos', format: 'number', caption: '$1.usage', captionFormat: 'bytes' },
  },
  {
    id: 'nextcloud', apps: ['nextcloud'], kind: 'http', port: 8080, path: '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json',
    header: { name: 'NC-Token' }, intervalSec: 300,
    widget: { display: 'number', value: '$1.ocs.data.activeUsers.last5minutes', format: 'number' },
  },
  {
    id: 'adguard', apps: ['adguardhome', 'adguard-home', 'adguard'], kind: 'http', port: 3000, path: '/control/stats',
    header: { name: 'Authorization', prefix: 'Basic ' }, intervalSec: 300,
    widget: { display: 'gauge', value: '$1.num_blocked_filtering / $1.num_dns_queries * 100', format: 'percent', min: '0', max: '100' },
  },
  {
    id: 'homeassistant', apps: ['homeassistant', 'home-assistant'], kind: 'http', port: 8123, path: '/api/states/sensor.example',
    header: { name: 'Authorization', prefix: 'Bearer ' }, intervalSec: 60,
    widget: { display: 'number', value: '$1.state', format: 'text', caption: '$1.attributes.friendly_name' },
  },
  {
    id: 'syncthing', apps: ['syncthing'], kind: 'http', port: 8384, path: '/rest/system/status',
    header: { name: 'X-API-Key' }, intervalSec: 300,
    widget: { display: 'number', value: '$1.uptime', format: 'duration' },
  },
  { id: 'cmdDf', kind: 'command', command: 'df', intervalSec: 300, widget: { display: 'list', value: 'count($1)', format: 'number', warn: '80', bad: '90', list: { path: '$1', label: '@.target', value: '@.used / @.size * 100', format: 'percent' } } },
  { id: 'cmdFailedUnits', kind: 'command', command: 'failed-units', intervalSec: 120, widget: { display: 'status', value: 'count($1)', format: 'number', warn: '1', bad: '1', caption: 'count($1)', captionFormat: 'number' } },
  { id: 'cmdDockerStats', kind: 'command', command: 'docker-stats', intervalSec: 60, widget: { display: 'list', value: 'count($1)', format: 'number', list: { path: '$1', label: '@.Name', value: '@.CPUPerc' } } },
  { id: 'cmdMdstat', kind: 'command', command: 'mdstat', intervalSec: 120, widget: { display: 'text', value: '$1.text', format: 'text' } },
  { id: 'cmdJournalErrors', kind: 'command', command: 'journal-errors', intervalSec: 300, widget: { display: 'list', value: 'count($1)', format: 'number', list: { path: '$1', label: '@.SYSLOG_IDENTIFIER', value: '@.MESSAGE' } } },
]

/** The template's address on the server, with the app's published port when it is installed. */
export function templateUrl(t: SourceTemplate, installedPort?: number): string {
  return `http://127.0.0.1:${installedPort ?? t.port}${t.path ?? '/'}`
}
