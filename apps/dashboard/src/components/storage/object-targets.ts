// The names a storage object's operations are logged under in the audit log
// (the `target` the audit middleware extracts from each call's input), so the
// Activity tab finds them (#40).

export type TargetVolume = {
  id: string
  device?: string
  mountPoint?: string
  stack: Array<{ kind: string; name: string }>
}

/** `mountPoint` may be remembered by the page: an unmount clears it from the
 *  volume, but the unmount itself is logged under it. */
export function volumeTargets(v: TargetVolume, rememberedMount?: string): string[] {
  const lv = v.stack.find(l => l.kind === 'lv')?.name
  const vg = v.stack.find(l => l.kind === 'vg')?.name
  const names = [
    v.device,
    v.device && `/dev/${v.device}`,
    // Mount and format dialogs send an LV as its lsblk path (mapper/<dm>) or,
    // from the LVM section, as <vg>/<lv>.
    v.device && lv && `mapper/${v.device}`,
    lv && vg && `${vg}/${lv}`,
    v.mountPoint,
    rememberedMount,
    v.id.startsWith('missing:') ? undefined : v.id,
  ]
  return [...new Set(names.filter((n): n is string => !!n))].slice(0, 20)
}

// Member operations (fail, remove, add) are logged under the member device;
// the activity query finds them through the array name (see storage.activity).
export function arrayTargets(a: { name: string; mountPoint?: string }): string[] {
  // An unmount is logged under the mount point.
  return [a.name, `/dev/${a.name}`, ...(a.mountPoint ? [a.mountPoint] : [])]
}

// Device-mapper name of an LV: dashes in the VG and LV names are doubled.
const dmName = (vg: string, lv: string) => `${vg.replace(/-/g, '--')}-${lv.replace(/-/g, '--')}`

export function vgTargets(vg: { name: string; lvs: string[]; mountPoints?: string[] }): string[] {
  return [...new Set([
    vg.name,
    ...vg.lvs.flatMap(lv => [`${vg.name}/${lv}`, `mapper/${dmName(vg.name, lv)}`]),
    ...(vg.mountPoints ?? []),
  ])].slice(0, 20)
}
