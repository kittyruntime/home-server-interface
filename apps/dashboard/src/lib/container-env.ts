export interface ContainerEnv { key: string; value: string }

/** Split on the first equals sign so credentials and empty values survive editing. */
export function parseContainerEnv(raw: string): ContainerEnv[] {
  return raw.split('\n').filter(line => !line.trimStart().startsWith('#') && line.includes('='))
    .map(line => ({ key: line.slice(0, line.indexOf('=')).trim(), value: line.slice(line.indexOf('=') + 1) }))
    .filter(entry => entry.key)
}

export function serializeContainerEnv(entries: ContainerEnv[]): string {
  return entries.filter(entry => entry.key).map(entry => `${entry.key}=${entry.value}`).join('\n')
}
