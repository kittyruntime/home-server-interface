// The LVM wizard runs three plans in a row (PV, VG, LV). If the owner stops
// after the first, the disks are PVs without a volume group: the wizard offers
// them again and skips pvcreate for them, so it can simply be run again.

type Pv = { name: string; vgName: string }
type Dev = { name: string; children?: Dev[] }

export function orphanPvNames(pvs: Pv[]): Set<string> {
  return new Set(pvs.filter(p => !p.vgName).map(p => p.name.replace(/^\/dev\//, '')))
}

export function pvCreateNeeded(pvDevs: string[], pvs: Pv[]): string[] {
  const orphans = orphanPvNames(pvs)
  return pvDevs.filter(d => !orphans.has(d))
}

export function withOrphanPvs<T extends Dev>(eligible: T[], devices: T[], pvs: Pv[]): T[] {
  const orphans = orphanPvNames(pvs)
  const out = [...eligible]
  const seen = new Set(eligible.map(d => d.name))
  const walk = (d: T) => {
    if (orphans.has(d.name) && !seen.has(d.name)) {
      out.push(d)
      seen.add(d.name)
    }
    ;(d.children as T[] | undefined)?.forEach(walk)
  }
  devices.forEach(walk)
  return out
}
