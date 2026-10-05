package main

import (
	"reflect"
	"strings"
	"testing"
)

const raid5Detail = `/dev/md3:
           Raid Level : raid5
                 UUID : 11:22:33:44
    Number   Major   Minor   RaidDevice State
       0       8       32        0      active sync   /dev/sdc
       1       8       48        1      active sync   /dev/sdd
       2       8       64        2      active sync   /dev/sde
`

const mirrorDetail = `/dev/md1:
           Raid Level : raid1
                 UUID : 55:66:77:88
    Number   Major   Minor   RaidDevice State
       0       8        0        0      active sync   /dev/sda
       1       8       16        1      active sync   /dev/sdb
`

// stubExpandHost: LV data/data, ext4, mounted on /srv/data, VG data on the
// RAID 5 md3 (sdc, sdd, sde), sdf free and as large as the members.
func stubExpandHost(t *testing.T) {
	t.Helper()
	stubRemoveHost(t)
	stubConfigFiles(t, "", "")
	t.Setenv("HSI_EXPANSIONS", t.TempDir()+"/expansions.json")
	pf, ps, pc, pv, pz, pw, pd := hostFSType, hostSyncAction, hostComponentSize, hostVgFree, hostDeviceSize, hostWholeDisk, hostMdDetail
	t.Cleanup(func() {
		hostFSType, hostSyncAction, hostComponentSize, hostVgFree, hostDeviceSize, hostWholeDisk, hostMdDetail = pf, ps, pc, pv, pz, pw, pd
	})
	hostFSType = func(string) string { return "ext4" }
	hostSyncAction = func(string) string { return "idle" }
	hostComponentSize = func(string) int64 { return 32e9 }
	hostVgFree = func(string) int64 { return 0 }
	hostDeviceSize = func(string) (int64, error) { return 32e9, nil }
	hostWholeDisk = func(string) bool { return true }
	hostPvs = func() []lvmPV { return []lvmPV{{Name: "/dev/md3", VGName: "data"}} }
	hostMdDetail = func(d string) (string, error) {
		if d == "/dev/md1" {
			return mirrorDetail, nil
		}
		return raid5Detail, nil
	}
	hostDevsByUUID = func(uuid string) []string {
		if uuid == "fs-1" {
			return []string{"/dev/mapper/data-data"}
		}
		return nil
	}
}

func expand(t *testing.T, mode, disk string) (*opPlan, *fsError) {
	t.Helper()
	in := `{"uuid":"fs-1","mode":"` + mode + `"`
	if disk != "" {
		in += `,"disk":"` + disk + `"`
	}
	return build(t, planVolumeExpand, in+"}")
}

func TestPlanVolumeExpandVgFree(t *testing.T) {
	stubExpandHost(t)
	hostVgFree = func(string) int64 { return 10e9 }
	p, fe := expand(t, "vgFree", "")
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"lvextend", "-l", "+100%FREE", "/dev/data/data"}, {"resize2fs", "/dev/data/data"}}
	if !reflect.DeepEqual(argvs(p), want) || p.Reply["pending"] != false {
		t.Fatalf("commands: %v reply %v", argvs(p), p.Reply)
	}
	assertParity(t, p)
	hostVgFree = func(string) int64 { return 0 }
	if _, fe := expand(t, "vgFree", ""); fe == nil {
		t.Fatal("no free space: refused")
	}
}

func TestPlanVolumeExpandAddDisk(t *testing.T) {
	stubExpandHost(t)
	hostPvs = func() []lvmPV { return []lvmPV{{Name: "/dev/sde", VGName: "data"}} }
	p, fe := expand(t, "addDisk", "sdf")
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"pvcreate", "-f", "/dev/sdf"}, {"vgextend", "data", "/dev/sdf"}, {"lvextend", "-l", "+100%FREE", "/dev/data/data"}, {"resize2fs", "/dev/data/data"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	if p.Steps[0].Kind != "info" || !strings.Contains(p.Steps[0].Summary, "depend on one more disk") {
		t.Fatalf("says the volume depends on one more disk: %+v", p.Steps[0])
	}
	for _, s := range p.Steps {
		if len(s.Command) > 0 && s.Command[0] == "pvcreate" && (!s.Destructive || s.Device == nil) {
			t.Fatal("the new disk is named as erased")
		}
	}
	// A volume on an array grows by raidAddDisk, not by an unprotected disk.
	stubExpandHost(t)
	if _, fe := expand(t, "addDisk", "sdf"); fe == nil {
		t.Fatal("addDisk on a RAID volume: refused")
	}
}

func TestPlanVolumeExpandRaidAddDisk(t *testing.T) {
	stubExpandHost(t)
	p, fe := expand(t, "raidAddDisk", "sdf")
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"wipefs", "-a", "/dev/sdf"}, {"mdadm", "--add", "/dev/md3", "/dev/sdf"}, {"mdadm", "--grow", "/dev/md3", "--raid-devices=4"}}
	if !reflect.DeepEqual(argvs(p), want) || p.Reply["pending"] != true {
		t.Fatalf("commands: %v reply %v", argvs(p), p.Reply)
	}
	last := p.Steps[len(p.Steps)-1]
	if !last.Deferred {
		t.Fatalf("the end of the expansion is deferred: %+v", last)
	}
	assertParity(t, p)
	got := loadExpansions()
	if len(got) != 1 || got[0].Phase != "reshape" || got[0].Array != "md3" || got[0].LV != "/dev/data/data" {
		t.Fatalf("pending entry: %+v", got)
	}
	// Now one is pending: a second expansion is refused.
	if _, fe := expand(t, "raidAddDisk", "sdf"); fe == nil || fe.Code != "EEXIST" {
		t.Fatalf("one expansion at a time: %+v", fe)
	}
}

func TestPlanVolumeExpandMirrorGrow(t *testing.T) {
	stubExpandHost(t)
	hostPvs = func() []lvmPV { return []lvmPV{{Name: "/dev/md1", VGName: "data"}} }
	hostComponentSize = func(string) int64 { return 30e9 }
	hostDeviceSize = func(string) (int64, error) { return 40e9, nil }
	p, fe := expand(t, "mirrorGrow", "")
	if fe != nil {
		t.Fatal(fe)
	}
	if !reflect.DeepEqual(argvs(p), [][]string{{"mdadm", "--grow", "/dev/md1", "--size=max"}}) || !p.Steps[len(p.Steps)-1].Deferred {
		t.Fatalf("commands: %v", argvs(p))
	}
	hostDeviceSize = func(string) (int64, error) { return 30e9, nil }
	stubConfigFiles(t, "", "")
	t.Setenv("HSI_EXPANSIONS", t.TempDir()+"/e.json")
	if _, fe := expand(t, "mirrorGrow", ""); fe == nil {
		t.Fatal("members no larger: nothing to grow")
	}
}

func TestPlanVolumeExpandFilesystems(t *testing.T) {
	stubExpandHost(t)
	hostVgFree = func(string) int64 { return 10e9 }
	growArgv := func() []string {
		p, fe := expand(t, "vgFree", "")
		if fe != nil {
			t.Fatal(fe)
		}
		a := argvs(p)
		return a[len(a)-1]
	}
	hostFSType = func(string) string { return "xfs" }
	if got := growArgv(); !reflect.DeepEqual(got, []string{"xfs_growfs", "/srv/data"}) {
		t.Fatalf("xfs: %v", got)
	}
	hostFSType = func(string) string { return "btrfs" }
	if got := growArgv(); !reflect.DeepEqual(got, []string{"btrfs", "filesystem", "resize", "max", "/srv/data"}) {
		t.Fatalf("btrfs: %v", got)
	}
	// Unmounted ext4 is checked, then grown offline.
	hostFSType = func(string) string { return "ext4" }
	hostProcMounts = func() string { return "/dev/sda2 / ext4 rw 0 0\n" }
	p, _ := expand(t, "vgFree", "")
	a := argvs(p)
	if !reflect.DeepEqual(a[1], []string{"e2fsck", "-f", "-p", "/dev/data/data"}) || !reflect.DeepEqual(a[2], []string{"resize2fs", "/dev/data/data"}) {
		t.Fatalf("offline ext4: %v", a)
	}
	hostFSType = func(string) string { return "xfs" }
	if _, fe := expand(t, "vgFree", ""); fe == nil || !strings.Contains(fe.Message, "mounted") {
		t.Fatalf("unmounted xfs: %+v", fe)
	}
	hostFSType = func(string) string { return "vfat" }
	if _, fe := expand(t, "vgFree", ""); fe == nil || !strings.Contains(fe.Message, "not supported") {
		t.Fatalf("vfat: %+v", fe)
	}
}

func TestPlanVolumeExpandRefusals(t *testing.T) {
	stubExpandHost(t)
	hostSyncAction = func(string) string { return "recover" }
	if _, fe := expand(t, "raidAddDisk", "sdf"); fe == nil || fe.Code != "EBUSY" {
		t.Fatalf("array syncing: %+v", fe)
	}
	hostSyncAction = func(string) string { return "idle" }
	hostDeviceSize = func(d string) (int64, error) {
		if d == "/dev/sdf" {
			return 16e9, nil
		}
		return 32e9, nil
	}
	if _, fe := expand(t, "raidAddDisk", "sdf"); fe == nil || !strings.Contains(fe.Message, "too small") {
		t.Fatalf("small disk: %+v", fe)
	}
	hostDeviceSize = func(string) (int64, error) { return 32e9, nil }
	hostWholeDisk = func(string) bool { return false }
	if _, fe := expand(t, "raidAddDisk", "sdf1"); fe == nil {
		t.Fatal("not a whole disk: refused")
	}
	hostWholeDisk = func(string) bool { return true }
	hostClaimable = func(string) *fsError { return &fsError{Code: "EBUSY", Message: "sdf holds data"} }
	if _, fe := expand(t, "raidAddDisk", "sdf"); fe == nil {
		t.Fatal("a disk that holds data: refused")
	}
	hostClaimable = func(string) *fsError { return nil }
	if _, fe := expand(t, "shrink", ""); fe == nil {
		t.Fatal("unknown mode")
	}
}

func TestPlanVolumeExpandStale(t *testing.T) {
	stubExpandHost(t)
	hostVgFree = func(string) int64 { return 10e9 }
	in := []byte(`{"uuid":"fs-1","mode":"vgFree"}`)
	p1, _ := planVolumeExpand(in)
	hostLvs = func() []lvmLV {
		return []lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}, {Name: "new", VGName: "data", Path: "/dev/data/new"}}
	}
	p2, _ := planVolumeExpand(in)
	if p1.fingerprint(in) == p2.fingerprint(in) {
		t.Fatal("a new LV in the VG makes the plan stale")
	}
}

const raid5Degraded = `/dev/md3:
           Raid Level : raid5
         Raid Devices : 3
                State : clean, degraded
                 UUID : 11:22:33:44
    Number   Major   Minor   RaidDevice State
       0       8       32        0      active sync   /dev/sdc
       1       8       48        1      active sync   /dev/sdd
       -       0        0        2      removed
`

const raid5WithSpare = `/dev/md3:
           Raid Level : raid5
         Raid Devices : 3
                State : clean
                 UUID : 11:22:33:44
    Number   Major   Minor   RaidDevice State
       0       8       32        0      active sync   /dev/sdc
       1       8       48        1      active sync   /dev/sdd
       2       8       64        2      active sync   /dev/sde
       3       8       80        -      spare   /dev/sdg
`

func TestPlanVolumeExpandRaidState(t *testing.T) {
	stubExpandHost(t)
	hostMdDetail = func(string) (string, error) { return raid5Degraded, nil }
	if _, fe := expand(t, "raidAddDisk", "sdf"); fe == nil || !strings.Contains(fe.Message, "degraded") {
		t.Fatalf("a degraded array is not reshaped: %+v", fe)
	}
	hostMdDetail = func(string) (string, error) { return raid5WithSpare, nil }
	if _, fe := expand(t, "raidAddDisk", "sdf"); fe == nil || !strings.Contains(fe.Message, "spare") {
		t.Fatalf("a spare would be consumed by the reshape: %+v", fe)
	}
}

// The entry records the array's identity and size before the grow, so its
// end is told by the size, not by an idle sync_action.
func TestPlanVolumeExpandRecordsArraySize(t *testing.T) {
	stubExpandHost(t)
	pa := hostArraySize
	t.Cleanup(func() { hostArraySize = pa })
	hostArraySize = func(string) int64 { return 64e9 }
	p, fe := expand(t, "raidAddDisk", "sdf")
	if fe != nil {
		t.Fatal(fe)
	}
	assertParity(t, p)
	e := loadExpansions()[0]
	if e.ArrayUUID != "11:22:33:44" || e.OldSize != 64e9 {
		t.Fatalf("identity and size recorded: %+v", e)
	}
}
