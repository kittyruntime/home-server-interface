import ui from './en/index'
import uip from './en/params/index'
// English messages: the source language. Every key here must exist in the
// other languages (a test checks it); text says what the UI says, nothing more.
export default {
  common: {
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Retry',
    save: 'Save',
    loading: 'Loading…',
    section: 'Section',
    sections: 'Sections',
  },
  apps: {
    files: 'Files',
    apps: 'Apps',
    settings: 'Settings',
    storage: 'Storage',
    store: 'App Store',
    monitor: 'Monitor',
    sharing: 'Sharing',
    filePreview: 'Preview',
  },
  settings: {
    groups: { account: 'Account', access: 'Access control', system: 'System', backup: 'Backups' },
    nav: {
      profile: 'My profile',
      shares: 'Shared links',
      users: 'Users',
      places: 'Places',
      permissions: 'Permissions',
      groups: 'Groups',
      alerting: 'Alert thresholds',
      notifications: 'Notifications',
      secure: 'Secure access',
      network: 'Network',
      updates: 'Updates',
      telemetry: 'Telemetry',
      backups: 'Backup & restore',
      dataBackups: 'Data backups',
    },
  },
  storage: {
    nav: { volumes: 'Volumes', disks: 'Disks', raid: 'Arrays', lvm: 'Volume groups', mounts: 'Mounts', maintenance: 'Maintenance' },
    createVolume: 'Create volume',
  },
  monitor: {
    nav: { overview: 'Summary', systemInfo: 'System info', monitoring: 'Monitoring', alerts: 'Alerts', audit: 'Audit log' },
  },
  sharing: {
    nav: { shares: 'Shares', connections: 'Connections', diagnostics: 'Diagnostics' },
  },
  account: {
    administrator: 'Administrator',
    user: 'User',
    profile: 'Profile',
    desktopMode: 'Desktop mode',
    resetSidebar: 'Reset sidebar order',
    signOut: 'Sign out',
  },
  login: {
    username: 'Username',
    usernamePlaceholder: 'Your username',
    password: 'Password',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    signIn: 'Sign In',
    signingIn: 'Signing in…',
    invalid: 'Invalid username or password',
  },
  ui,
  uip,
  profile: {
    language: 'Language',
    languageHint: 'The language of the interface on every device you sign in to.',
  },
}
