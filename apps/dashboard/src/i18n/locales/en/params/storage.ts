// Messages with parameters ({p0}, {p1}…), generated from the templates.
export default {
  MaintenanceSection: {
    notRunAt: 'Not run at {p0}: {p1}. {p2}',
  },
  LvmSection: {
    volumeGroup: '{p0} volume group{p1}',
    free: '· {p0} free',
    willDestroyAllLogicalVolume: 'will destroy all {p0} Logical Volume(s) and their data.',
  },
  VolumePage: {
    usedOfFree: 'used of {p0} · {p1} free',
    survivesFailed: '· survives {p0} failed {p1}',
    theItHolds: 'the {p0} it holds',
    dataHereRemoveFirst: '{p0} {p1} data here: remove {p2} first.',
  },
  DiskPage: {
    couldNotRefreshThisDisk: 'Could not refresh this disk: {p0}. What is shown may be out of date.',
    hoursPoweredOn: '{p0} hours powered on',
  },
  ImportFound: {
    ofMembersNotFound: '{p0} of {p1} members not found',
    disksCarryThisArrayWhich: '{p0} disks carry this array, which has {p1}: one is probably a copy of another, such as a cloned disk. Disconnect the disk that should not be there, then scan again.',
  },
  VolumeHealthPanel: {
    notProtectedAgainstWritesWhile: 'Not protected against writes while unmounted: {p0}',
    blockedSinceAppsUsingIt: 'Blocked since {p0}: apps using it are stopped, its shares are unavailable, backups and file writes are refused.',
    volumeIsBack: 'Volume {p0} is back.',
    filesWereWrittenToThe: 'Files were written to the system disk under {p0} before it was protected. To reach them, unmount the volume and run',
  },
  PhysicalDisksSection: {
    onFreeDisks: '{p0} on free disks',
    sort: 'Sort: {p0}',
    showingOfDisks: 'Showing {p0} of {p1} disks ·',
    freeSelected: '{p0} free {p1} selected',
  },
  DiskCard: {
    poweredOn: '{p0} powered on',
    powerCycles: '{p0} power cycles',
    min: '(min {p0}%)',
    raid: 'RAID {p0} →',
    lvm: 'LVM {p0} →',
  },
  RaidSection: {
    lvm: 'LVM {p0} →',
    emptySlotAddAReplacement: '{p0} empty slot{p1}: add a replacement disk to restore redundancy.',
    free: '{p0} free · {p1}%',
    minDrives: 'Min: {p0} drives',
    redundancy: 'Redundancy: {p0}',
    minimumRequired: 'Minimum {p0} required.',
    ofRaw: 'of {p0} raw ({p1}%) · {p2}',
    unusedOnDevDrivesAre: '{p0} unused on /dev/{p1} (drives are used at the size of the smallest one)',
    requiresAtLeastDrivesSelected: '{p0} requires at least {p1} drives ({p2} selected).',
    usableOfRaw: '{p0} usable of {p1} raw ({p2}%)',
  },
  StoragePanel: {
    someStorageToolsAreNot: 'Some storage tools are not installed on the server, so these features are unavailable: {p0}.',
  },
  CreateVolumeWizard: {
    stepOf: 'Step {p0} of {p1} · {p2}',
    usable: 'usable · {p0}',
    aVolumeGroupNamedAlready: 'A volume group named {p0} already exists.',
    useOfTheVolumeGroup: 'Use {p0}% of the volume group',
    ext4: 'ext4 · {p0}',
    survivesFailed: '· survives {p0} failed {p1}',
    place: 'Place "{p0}"',
    next: 'Next: {p0}',
  },
  DeviceFormatWizard: {
    nowHoldsAnEmptyFilesystem: 'now holds an empty {p0} filesystem. Mount it to choose who can write to it and to create a Place for it.',
  },
  ExpandVolumeDialog: {
    expand: 'Expand {p0}',
  },
}
