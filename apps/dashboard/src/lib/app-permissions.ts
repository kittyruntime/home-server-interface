import { tr } from './tr.ts'
export type PermissionKind = 'Storage' | 'Network' | 'Secret' | 'Startup'

export interface Permission {
  kind: PermissionKind
  title: string
  detail: string
  note?: string
}

export interface PermissionSource {
  volumes: { target: string; label: string; readOnlyDefault: boolean }[]
  ports: { container: number; protocol: string; label: string }[]
  env: { key: string; prompt?: string; secret: boolean }[]
  restartPolicy: string
  webUiPort?: number
}

/** Describe catalog access in a stable, human-readable order. */
export function appPermissions(app: PermissionSource): Permission[] {
  const permissions: Permission[] = app.volumes.map(volume => ({
    kind: 'Storage',
    title: `${volume.readOnlyDefault ? tr('lib.app_permissions.read', 'Read') : 'Read and write'} ${volume.label}`,
    detail: volume.target,
    ...(volume.readOnlyDefault ? { note: tr('lib.app_permissions.readOnly', 'Read-only') } : {}),
  }))

  const ports = new Map<number, { label: string; protocols: string[] }>()
  for (const port of app.ports) {
    const entry = ports.get(port.container)
    if (entry) {
      if (!entry.protocols.includes(port.protocol)) entry.protocols.push(port.protocol)
    } else {
      ports.set(port.container, { label: port.label, protocols: [port.protocol] })
    }
  }
  for (const [container, port] of ports) {
    permissions.push({
      kind: 'Network',
      title: tr('lib.app_permissions.listensOn', `Listens on ${port.label}`, { p0: port.label }),
      detail: `${container}/${port.protocols.join('+')}`,
      ...(container === app.webUiPort ? { note: tr('lib.app_permissions.webInterface', 'Web interface') } : {}),
    })
  }

  const secrets = app.env.filter(env => env.secret)
  if (secrets.length) {
    permissions.push({ kind: 'Secret', title: tr('lib.app_permissions.storesASecret', 'Stores a secret'), detail: secrets.map(env => env.prompt || env.key).join(', ') })
  }
  if (app.restartPolicy !== 'no') {
    permissions.push({ kind: 'Startup', title: tr('lib.app_permissions.startsWithYourServer', 'Starts with your server'), detail: app.restartPolicy })
  }
  return permissions
}
