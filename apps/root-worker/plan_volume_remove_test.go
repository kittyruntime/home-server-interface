package main

import (
	"reflect"
	"strings"
	"testing"
)

const removeMdDetail = `/dev/md1:
           Raid Level : raid1
                 UUID : 8f141419:3645cae9:e96910cf:7e5bc72b
    Number   Major   Minor   RaidDevice State
       0       8        0        0      active sync   /dev/sda
       1       8       16        1      active sync   /dev/sdb
`

// stubRemoveHost: an LVM volume "data" on the mirror md1 (sda, sdb), mounted
// on /srv/data, with its HSI fstab entry and mdadm.conf ARRAY line.
func stubRemoveHost(t *testing.T) {
	t.Helper()
	stubMountHost(t)
	stubConfigFiles(t,
		"UUID=root / ext4 defaults 0 1\n# HSI-managed mount: /srv/data\nUUID=fs-1\t/srv/data\text4\tdefaults,nofail\t0\t2\n",
		"# HSI-managed array: md1\nARRAY /dev/md1 metadata=1.2 UUID=8f141419:3645cae9:e96910cf:7e5bc72b\n")
	pd, pp, pb, pl := hostDevByUUID, hostPvs, hostBusy, hostLookPath
	t.Cleanup(func() { hostDevByUUID, hostPvs, hostBusy, hostLookPath = pd, pp, pb, pl })
	hostDevByUUID = func(uuid string) string {
		if uuid == "fs-1" {
			return "/dev/mapper/data-data"
		}
		return ""
	}
	hostLvs = func() []lvmLV { return []lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}} }
	hostPvs = func() []lvmPV { return []lvmPV{{Name: "/dev/md1", VGName: "data"}} }
	hostBusy = func(string) []string { return nil }
	hostMdDetail = func(string) (string, error) { return removeMdDetail, nil }
	hostProcMounts = func() string { return "/dev/sda2 / ext4 rw 0 0\n/dev/mapper/data-data /srv/data ext4 rw 0 0\n" }
	hostSystemDevs = func() map[string]bool { return map[string]bool{"sdz": true} }
}

const removeReq = `{"uuid":"fs-1"}`

func TestPlanVolumeRemoveMirror(t *testing.T) {
	stubRemoveHost(t)
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{
		{"umount", "/srv/data"},
		{"chattr", "-i", "/srv/data"},
		{"lvremove", "-f", "/dev/data/data"},
		{"vgremove", "-f", "data"},
		{"pvremove", "-f", "/dev/md1"},
		{"mdadm", "--stop", "/dev/md1"},
		{"mdadm", "--zero-superblock", "/dev/sda"},
		{"mdadm", "--zero-superblock", "/dev/sdb"},
		{"update-initramfs", "-u"},
		{"wipefs", "-a", "/dev/sda"},
		{"wipefs", "-a", "/dev/sdb"},
	}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands:\n got %v\nwant %v", argvs(p), want)
	}
	var targets []string
	for _, s := range p.Steps {
		if s.Kind == "update" {
			targets = append(targets, s.Target)
		}
		if len(s.Command) > 1 && s.Command[1] == "--zero-superblock" && (!s.Destructive || s.Device == nil) {
			t.Fatalf("erasing a member must name the disk: %+v", s)
		}
		if len(s.Command) > 0 && s.Command[0] == "lvremove" && !s.Destructive {
			t.Fatal("deleting the LV is destructive")
		}
	}
	if !reflect.DeepEqual(targets, []string{fstabPath, mdadmConfPath}) {
		t.Fatalf("fstab and mdadm.conf are edited: %v", targets)
	}
	if got := p.Reply["freed"]; !reflect.DeepEqual(got, []string{"/dev/sda", "/dev/sdb"}) {
		t.Fatalf("freed disks: %v", got)
	}
	assertParity(t, p)
}

func TestPlanVolumeRemoveSharedVG(t *testing.T) {
	stubRemoveHost(t)
	hostLvs = func() []lvmLV {
		return []lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}, {Name: "other", VGName: "data", Path: "/dev/data/other"}}
	}
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"umount", "/srv/data"}, {"chattr", "-i", "/srv/data"}, {"lvremove", "-f", "/dev/data/data"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	if p.Steps[0].Kind != "info" || p.Steps[0].Summary != "data keeps 1 other logical volume: it stays" {
		t.Fatalf("first step says what stays: %+v", p.Steps[0])
	}
	if got := p.Reply["freed"]; len(got.([]string)) != 0 {
		t.Fatalf("nothing is freed: %v", got)
	}
}

func TestPlanVolumeRemovePlainDisk(t *testing.T) {
	stubRemoveHost(t)
	stubConfigFiles(t, "# HSI-managed mount: /srv/data\nUUID=fs-1\t/srv/data\text4\tdefaults,nofail\t0\t2\n", "")
	hostDevByUUID = func(string) string { return "/dev/sdf" }
	hostProcMounts = func() string { return "/dev/sdf /srv/data ext4 rw 0 0\n" }
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"umount", "/srv/data"}, {"chattr", "-i", "/srv/data"}, {"wipefs", "-a", "/dev/sdf"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	assertParity(t, p)
}

func TestPlanVolumeRemoveNotMounted(t *testing.T) {
	stubRemoveHost(t)
	hostProcMounts = func() string { return "/dev/sda2 / ext4 rw 0 0\n" }
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	if argvs(p)[0][0] == "umount" {
		t.Fatal("nothing to unmount")
	}
	found := false
	for _, s := range p.Steps {
		found = found || (s.Kind == "update" && s.Target == fstabPath)
	}
	if !found {
		t.Fatal("the fstab entry found by UUID is still removed")
	}
}

func TestPlanVolumeRemoveRefusals(t *testing.T) {
	stubRemoveHost(t)
	if _, fe := build(t, planVolumeRemove, `{"uuid":"nope"}`); fe == nil || fe.Code != "ENOENT" {
		t.Fatalf("unknown UUID: %+v", fe)
	}
	hostSystemDevs = func() map[string]bool { return map[string]bool{"sda": true} }
	if _, fe := build(t, planVolumeRemove, removeReq); fe == nil || fe.Code != "ESYS" {
		t.Fatalf("a system disk underneath: %+v", fe)
	}
	hostSystemDevs = func() map[string]bool { return map[string]bool{} }
	hostBusy = func(string) []string { return []string{"smbd"} }
	if _, fe := build(t, planVolumeRemove, removeReq); fe == nil || fe.Code != "EBUSY" || !strings.Contains(fe.Message, "smbd") {
		t.Fatalf("busy mount point: %+v", fe)
	}
}

func TestPlanVolumeRemoveStale(t *testing.T) {
	stubRemoveHost(t)
	in := []byte(removeReq)
	p1, _ := planVolumeRemove(in)
	hostLvs = func() []lvmLV {
		return []lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}, {Name: "new", VGName: "data", Path: "/dev/data/new"}}
	}
	p2, _ := planVolumeRemove(in)
	if p1.fingerprint(in) == p2.fingerprint(in) {
		t.Fatal("a new LV in the VG must make the plan stale")
	}
}
