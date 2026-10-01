package main

import (
	"reflect"
	"strings"
	"testing"
)

func stubVolumeHost(t *testing.T) {
	t.Helper()
	stubMountHost(t)
	stubConfigFiles(t, "UUID=root / ext4 defaults 0 1\n", "")
	pm, pv, pd, pk := hostMdNames, hostVgNames, hostDirEmpty, hostMkdir
	t.Cleanup(func() { hostMdNames, hostVgNames, hostDirEmpty, hostMkdir = pm, pv, pd, pk })
	hostMkdir = func(string) error { return nil }
	hostMdNames = func() []string { return nil }
	hostVgNames = func() []string { return nil }
	hostDirEmpty = func(string) bool { return true }
	hostExists = func(string) bool { return false }
}

const mirrorReq = `{"disks":["sdf","sdg"],"redundancy":"raid1","vg":"data","lv":"data","lvPercent":100,"label":"data","mountpoint":"/srv/data","access":"shared","ownerUser":"alice"}`

func TestPlanVolumeCreateMirror(t *testing.T) {
	stubVolumeHost(t)
	p, fe := build(t, planVolumeCreate, mirrorReq)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{
		{"mdadm", "--create", "/dev/md0", "--level", "1", "--raid-devices", "2", "--run", "/dev/sdf", "/dev/sdg"},
		{"update-initramfs", "-u"},
		{"pvcreate", "/dev/md0"},
		{"vgcreate", "data", "/dev/md0"},
		{"lvcreate", "-y", "-l", "100%FREE", "-n", "data", "data"},
		{"mkfs.ext4", "-F", "-L", "data", "/dev/data/data"},
		{"chattr", "+i", "/srv/data"},
		{"mount", "/dev/data/data", "/srv/data"},
	}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands:\n got %v\nwant %v", argvs(p), want)
	}
	if !p.Steps[0].Destructive || len(p.Steps[0].Devices) != 2 {
		t.Fatalf("the array creation must name both erased disks: %+v", p.Steps[0])
	}
	var deferred []string
	for _, s := range p.Steps {
		if s.Deferred {
			deferred = append(deferred, s.Target)
		}
	}
	if !reflect.DeepEqual(deferred, []string{mdadmConfPath, fstabPath}) {
		t.Fatalf("mdadm.conf and fstab are only known after the run: %v", deferred)
	}
	assertParity(t, p)
}

func TestPlanVolumeCreateWithoutRedundancy(t *testing.T) {
	stubVolumeHost(t)
	p, fe := build(t, planVolumeCreate, `{"disks":["sdf"],"redundancy":"none","vg":"solo","lv":"solo","lvPercent":100,"label":"solo","mountpoint":"/srv/solo"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if got := argvs(p)[0]; !reflect.DeepEqual(got, []string{"pvcreate", "/dev/sdf"}) || !p.Steps[0].Destructive {
		t.Fatalf("a single disk becomes a PV, erased and named: %v %+v", got, p.Steps[0])
	}
	for _, a := range argvs(p) {
		if a[0] == "mdadm" {
			t.Fatal("no array without redundancy")
		}
	}
	p, _ = build(t, planVolumeCreate, `{"disks":["sdf","sdg"],"redundancy":"none","vg":"pool","lv":"pool","lvPercent":80,"label":"pool","mountpoint":"/srv/pool"}`)
	if !reflect.DeepEqual(argvs(p)[1], []string{"vgcreate", "pool", "/dev/sdf", "/dev/sdg"}) || !reflect.DeepEqual(argvs(p)[2], []string{"lvcreate", "-y", "-l", "80%FREE", "-n", "pool", "pool"}) {
		t.Fatalf("two disks without redundancy span one VG: %v", argvs(p))
	}
}

func TestPlanVolumeCreateRefusals(t *testing.T) {
	stubVolumeHost(t)
	cases := map[string]string{
		"level needs more disks": `{"disks":["sdf","sdg"],"redundancy":"raid5","vg":"d","lv":"d","lvPercent":100,"label":"d","mountpoint":"/srv/d"}`,
		"system mount point":     `{"disks":["sdf"],"redundancy":"none","vg":"d","lv":"d","lvPercent":100,"label":"d","mountpoint":"/home"}`,
		"bad VG name":            `{"disks":["sdf"],"redundancy":"none","vg":"bad name","lv":"d","lvPercent":100,"label":"d","mountpoint":"/srv/d"}`,
		"bad percent":            `{"disks":["sdf"],"redundancy":"none","vg":"d","lv":"d","lvPercent":0,"label":"d","mountpoint":"/srv/d"}`,
	}
	for name, in := range cases {
		if _, fe := build(t, planVolumeCreate, in); fe == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	hostVgNames = func() []string { return []string{"data"} }
	if _, fe := build(t, planVolumeCreate, mirrorReq); fe == nil || !strings.Contains(fe.Message, "data") {
		t.Fatalf("a taken VG name is refused: %+v", fe)
	}
	hostVgNames = func() []string { return nil }
	hostExists = func(string) bool { return true }
	hostDirEmpty = func(string) bool { return false }
	if _, fe := build(t, planVolumeCreate, mirrorReq); fe == nil || !strings.Contains(fe.Message, "not empty") {
		t.Fatalf("a mount point with content is refused: %+v", fe)
	}
	hostDirEmpty = func(string) bool { return true }
	hostClaimable = func(string) *fsError { return &fsError{Code: "EBUSY", Message: "sdg holds data"} }
	if _, fe := build(t, planVolumeCreate, mirrorReq); fe == nil || fe.Code != "EBUSY" {
		t.Fatalf("a disk that is not free is refused: %+v", fe)
	}
}

func TestPlanVolumeCreateNextMdName(t *testing.T) {
	stubVolumeHost(t)
	hostMdNames = func() []string { return []string{"md0", "md1"} }
	p, _ := build(t, planVolumeCreate, mirrorReq)
	if argvs(p)[0][2] != "/dev/md2" {
		t.Fatalf("the first free md name: %v", argvs(p)[0])
	}
}
