// Where Storage explains itself: the HSI guide pages, the glossary anchors of
// its technical terms, and the upstream documentation of the tools. Plain
// module, tested with node (tests/storage-docs.test.ts checks every link
// against the guide's Markdown).

const GUIDE_BASE = 'https://kittyruntime.github.io/home-server-interface/'

export type DocPage = 'storage' | 'disks' | 'lvm' | 'zfs' | 'maintenance' | 'glossary'

export const GUIDE_PAGES: Record<DocPage, string> = {
  storage:     'guide/features/storage/',
  disks:       'guide/features/storage-disks/',
  lvm:         'guide/features/storage-lvm/',
  zfs:         'guide/features/storage-zfs/',
  maintenance: 'guide/features/maintenance/',
  glossary:    'guide/features/storage-glossary/',
}

export type TermId =
  | 'raidLevel' | 'array' | 'volumeGroup' | 'logicalVolume' | 'filesystem' | 'smart' | 'raidCheck'
  | 'vdev' | 'raidz' | 'scrub' | 'resilver' | 'snapshot' | 'arc'

export const TERM_ANCHORS: Record<TermId, string> = {
  raidLevel: 'raid-level', array: 'array', volumeGroup: 'volume-group', logicalVolume: 'logical-volume',
  filesystem: 'filesystem', smart: 'smart', raidCheck: 'raid-check', vdev: 'vdev', raidz: 'raidz',
  scrub: 'scrub', resilver: 'resilver', snapshot: 'snapshot', arc: 'arc',
}

export function guideUrl(page: DocPage, anchor?: string): string {
  return GUIDE_BASE + GUIDE_PAGES[page] + (anchor ? `#${anchor}` : '')
}

export const UPSTREAM = {
  openzfs:       'https://openzfs.github.io/openzfs-docs/',
  lvm:           'https://sourceware.org/lvm2/',
  lvmMan:        'https://man7.org/linux/man-pages/man8/lvm.8.html',
  mdadm:         'https://docs.kernel.org/admin-guide/md.html',
  smartmontools: 'https://www.smartmontools.org/',
} as const

/** Key under which an intro card remembers it was closed. `lvm` keeps the key
 *  of the LVM explanation older releases showed, so a closed one stays closed. */
export const dismissKey = (id: string) => `${id}-intro-dismissed`

/** Whether the intro card `id` was closed. The storage is passed as a getter
 *  too: with site data blocked, merely reading `localStorage` throws. Either
 *  failure counts as not closed. */
export function isDismissed(id: string, storage: Pick<Storage, 'getItem'> | (() => Pick<Storage, 'getItem'>)): boolean {
  try {
    const s = typeof storage === 'function' ? storage() : storage
    return s.getItem(dismissKey(id)) === '1'
  } catch {
    return false
  }
}
