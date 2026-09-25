package main

import "strings"

// Device usage values sent to the dashboard, which only offers actions a
// usage allows (RAID/LVM members only allow the SMART check).
const (
	usageSystem      = "system"      // holds the operating system
	usageRaidMember  = "raid-member" // member of an md array (Owner: md0, or "" if inactive)
	usageLvmPV       = "lvm-pv"      // LVM physical volume (Owner: VG name, or "" if unknown)
	usageMounted     = "mounted"     // filesystem mounted somewhere
	usageFilesystem  = "filesystem"  // holds a filesystem that is not mounted
	usagePartitioned = "partitioned" // disk whose space is split into partitions
	usageFree        = "free"        // nothing on it: can be partitioned, formatted, or joined to an array/VG
)

// parsePvs parses `pvs --noheadings --separator : -o pv_name,vg_name`.
func parsePvs(out string) map[string]string {
	pvVG := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		pv, vg, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && pv != "" {
			pvVG[pv] = strings.TrimSpace(vg)
		}
	}
	return pvVG
}

// assignUsage sets Usage/Owner on dev and its whole subtree.
func assignUsage(dev *BlockDev, pvVG map[string]string) {
	switch {
	case dev.IsSystem:
		dev.Usage = usageSystem
	case dev.FsType == "linux_raid_member":
		dev.Usage = usageRaidMember
		for _, c := range dev.Children {
			if strings.HasPrefix(c.Type, "raid") {
				dev.Owner = c.Name
				break
			}
		}
	case dev.FsType == "LVM2_member":
		dev.Usage = usageLvmPV
		dev.Owner = pvVG[dev.Path]
	case dev.MountPoint != "":
		dev.Usage = usageMounted
	case dev.FsType != "":
		dev.Usage = usageFilesystem
	case hasPartitions(dev):
		dev.Usage = usagePartitioned
	default:
		dev.Usage = usageFree
	}
	for i := range dev.Children {
		assignUsage(&dev.Children[i], pvVG)
	}
}

func hasPartitions(dev *BlockDev) bool {
	for _, c := range dev.Children {
		if c.Type == "part" {
			return true
		}
	}
	return false
}
