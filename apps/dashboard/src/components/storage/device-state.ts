// RAID/LVM membership of a block device, from the worker's `usage` and
// `owner` (#30). The one place the dashboard decides it (#40).

export type MemberDev = { usage?: string; owner?: string; fstype: string }

// `owner` is null when the on-disk signature says so but the array/VG is not
// assembled or visible.
export type DeviceRole = { kind: 'raid' | 'lvm'; owner: string | null }

export function deviceRole(dev: MemberDev): DeviceRole | null {
  const usage = dev.usage
    // Workers older than the usage field: fall back to the on-disk signature.
    ?? (dev.fstype === 'linux_raid_member' ? 'raid-member' : dev.fstype === 'LVM2_member' ? 'lvm-pv' : undefined)
  if (usage === 'raid-member') return { kind: 'raid', owner: dev.owner || null }
  if (usage === 'lvm-pv') return { kind: 'lvm', owner: dev.owner || null }
  return null
}

/** The array (md0) or volume group using this device, when known. */
export function memberOwner(dev: MemberDev, kind: 'raid' | 'lvm'): string | undefined {
  const role = deviceRole(dev)
  return role?.kind === kind ? role.owner ?? undefined : undefined
}
