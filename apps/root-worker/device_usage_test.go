package main

import (
	"reflect"
	"testing"
)

func TestParsePvs(t *testing.T) {
	out := "  /dev/md0:data\n  /dev/vdd1:\n\n"
	want := map[string]string{"/dev/md0": "data", "/dev/vdd1": ""}
	if got := parsePvs(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("parsePvs() = %v, want %v", got, want)
	}
}

func TestAssignUsage(t *testing.T) {
	pvVG := map[string]string{"/dev/md0": "vg1"}
	disks := []BlockDev{
		{Name: "vda", Path: "/dev/vda", Type: "disk", IsSystem: true, Children: []BlockDev{
			{Name: "vda1", Path: "/dev/vda1", Type: "part", IsSystem: true, MountPoint: "/"},
		}},
		{Name: "vdb", Path: "/dev/vdb", Type: "disk", FsType: "linux_raid_member", Children: []BlockDev{
			{Name: "md0", Path: "/dev/md0", Type: "raid1", FsType: "LVM2_member", Children: []BlockDev{
				{Name: "vg1-lv0", Path: "/dev/vg1-lv0", Type: "lvm", FsType: "ext4", MountPoint: "/mnt/vg1-lv0"},
			}},
		}},
		{Name: "vdc", Path: "/dev/vdc", Type: "disk", FsType: "linux_raid_member"}, // inactive array
		{Name: "vdd", Path: "/dev/vdd", Type: "disk", Children: []BlockDev{
			{Name: "vdd1", Path: "/dev/vdd1", Type: "part", FsType: "ext4"},
			{Name: "vdd2", Path: "/dev/vdd2", Type: "part"},
		}},
		{Name: "vde", Path: "/dev/vde", Type: "disk"},
	}
	for i := range disks {
		assignUsage(&disks[i], pvVG)
	}
	check := func(dev BlockDev, usage, owner string) {
		t.Helper()
		if dev.Usage != usage || dev.Owner != owner {
			t.Errorf("%s: usage=%q owner=%q, want %q %q", dev.Name, dev.Usage, dev.Owner, usage, owner)
		}
	}
	check(disks[0], usageSystem, "")
	check(disks[0].Children[0], usageSystem, "")
	check(disks[1], usageRaidMember, "md0")
	check(disks[1].Children[0], usageLvmPV, "vg1")
	check(disks[1].Children[0].Children[0], usageMounted, "")
	check(disks[2], usageRaidMember, "")
	check(disks[3], usagePartitioned, "")
	check(disks[3].Children[0], usageFilesystem, "")
	check(disks[3].Children[1], usageFree, "")
	check(disks[4], usageFree, "")
}
