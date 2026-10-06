// Audit log actions in words, shared by the audit log and the activity of
// storage objects.
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    'auth.login':                   'Login',
    'auth.logout':                  'Logout',
    'fs.delete':                    'Delete file',
    'fs.mkdir':                     'Create folder',
    'fs.touch':                     'Create file',
    'fs.rename':                    'Rename',
    'fs.move':                      'Move',
    'fs.copy':                      'Copy',
    // Legacy `system.*` keys: storage mutations were logged under those paths before
    // the router split, and historical audit rows keep their original action string.
    'system.formatDisk':            'Format disk',
    'system.mountDevice':           'Mount device',
    'system.umountDevice':          'Unmount device',
    'system.initPartitionTable':    'Init partition table',
    'system.createPartition':       'Create partition',
    'system.deletePartition':       'Delete partition',
    'system.createRaid':            'Create RAID',
    'system.stopRaid':              'Stop RAID',
    'system.createPv':              'Create PV',
    'system.createVg':              'Create VG',
    'system.createLv':              'Create LV',
    'system.removeLv':              'Remove LV',
    'system.removeVg':              'Remove VG',
    'storage.formatDisk':           'Format disk',
    'storage.mountDevice':          'Mount device',
    'storage.umountDevice':         'Unmount device',
    'storage.initPartitionTable':   'Init partition table',
    'storage.createPartition':      'Create partition',
    'storage.deletePartition':      'Delete partition',
    'alert.clear':                  'Clear alert',
    'alert.clearAll':               'Clear all alerts',
    'storage.createRaid':           'Create RAID',
    'storage.stopRaid':             'Stop RAID',
    'storage.createPv':             'Create PV',
    'storage.createVg':             'Create VG',
    'storage.createLv':             'Create LV',
    'storage.removeLv':             'Remove LV',
    'storage.removeVg':             'Remove VG',
    'user.create':                  'Create user',
    'user.update':                  'Update user',
    'user.delete':                  'Delete user',
    'user.changePassword':          'Change password',
    'container.create':             'Create container',
    'container.delete':             'Delete container',
    'container.start':              'Start container',
    'container.stop':               'Stop container',
    'container.restart':            'Restart container',
    'container.app.create':         'Create container app',
    'container.app.update':         'Update container app',
    'container.app.apply':          'Apply container stack',
    'container.app.saveRaw':        'Edit container compose file',
    'container.app.remove':         'Remove container app',
    'catalog.install':              'Install app from catalog',
    'place.create':                 'Create place',
    'place.delete':                 'Delete place',
    'role.create':                  'Create role',
    'role.delete':                  'Delete role',
    'update.trigger':               'Trigger update',
    'update.restart':               'Restart HSI',
    'update.rebootHost':            'Reboot server',
    'system.configBackup':          'Export configuration backup',
    'backup.create':                'Create data backup plan',
    'backup.update':                'Update data backup plan',
    'backup.delete':                'Delete data backup plan',
    'backup.run':                   'Run data backup',
    'apps.plan':                    'Preview app change',
    'apps.apply':                   'Apply app change',
    'files.upload':                 'Upload file',
    'fs.chmod':                     'Change permissions',
    'fs.chown':                     'Change owner',
    'notifications.connectors.create': 'Create notification connector',
    'notifications.markAllRead':    'Mark notifications read',
    'notifications.renderPreview':  'Preview notification',
    'notifications.rules.update':   'Update notification rule',
    'notifications.testConnector':  'Test notification connector',
    'storage.plan':                 'Preview storage change',
    'storage.apply':                'Apply storage change',
    'storage.failRaidMember':       'Mark RAID disk as failed',
    'storage.runMaintenanceNow':    'Run disk checks now',
    'storage.volumePlan':           'Preview new volume',
    'storage.volumeApply':          'Create volume',
    'storage.volumeRemovePlan':     'Preview volume removal',
    'storage.volumeRemoveApply':    'Remove volume',
    'update.apply':                 'Install update',
    'update.check':                 'Check for updates',
    'user.updatePreferences':       'Update preferences',
  }
  return map[action] ?? humanize(action)
}

// An action without a label yet, in words: "widgets.resetLayout" reads
// "Widgets: reset layout".
function humanize(action: string): string {
  const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  const parts = action.split('.')
  const last = words(parts.pop() ?? '')
  const head = parts.length ? words(parts.join(' ')) : ''
  const text = head ? `${head}: ${last}` : last
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export type AuditCategory = 'auth' | 'fs' | 'system' | 'admin' | 'other'

export function actionCategory(action: string): AuditCategory {
  if (action.startsWith('auth.'))     return 'auth'
  if (action.startsWith('fs.') || action.startsWith('files.')) return 'fs'
  if (action.startsWith('system.') || action.startsWith('storage.'))   return 'system'
  if (action.startsWith('user.') || action.startsWith('role.') ||
      action.startsWith('place.') || action.startsWith('container.') || action.startsWith('apps.') ||
      action.startsWith('catalog.') || action.startsWith('update.'))   return 'admin'
  return 'other'
}

export const categoryClass: Record<AuditCategory, string> = {
  auth:   'bg-info/10 text-info border-info/20',
  fs:     'bg-violet/10 text-violet border-violet/20',
  system: 'bg-warning/10 text-warning border-warning/20',
  admin:  'bg-accent/10 text-accent border-accent/20',
  other:  'bg-[var(--c-surface-deep)] text-[var(--c-text-3)] border-[var(--c-border)]',
}
