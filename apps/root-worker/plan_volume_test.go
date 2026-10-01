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
	pm, pv, pd, pk, pw, pn := hostMdNames, hostVgNames, hostDirEmpty, hostMkdir, hostWholeDisk, hostMdNodes
	t.Cleanup(func() {
		hostMdNames, hostVgNames, hostDirEmpty, hostMkdir, hostWholeDisk, hostMdNodes = pm, pv, pd, pk, pw, pn
	})
	hostMdNodes = func() []string { return nil }
	hostMkdir = func(string) error { return nil }
	hostWholeDisk = func(string) bool { return true }
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
		{"wipefs", "-a", "/dev/md0"},
		{"pvcreate", "-f", "/dev/md0"},
		{"vgcreate", "data", "/dev/md0"},
		{"lvcreate", "-y", "-l", "100%FREE", "-n", "data", "data"},
		{"mkfs.ext4", "-F", "-E", "nodiscard", "-L", "data", "/dev/data/data"},
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
	if got := argvs(p)[0]; !reflect.DeepEqual(got, []string{"pvcreate", "-f", "/dev/sdf"}) || !p.Steps[0].Destructive {
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

func TestPlanVolumeCreateSafety(t *testing.T) {
	stubVolumeHost(t)
	// Only whole disks.
	hostWholeDisk = func(d string) bool { return d != "sdg1" }
	if _, fe := build(t, planVolumeCreate, strings.Replace(mirrorReq, `"sdg"`, `"sdg1"`, 1)); fe == nil {
		t.Fatal("a partition must be refused")
	}
	hostWholeDisk = func(string) bool { return true }
	// Not twice the same disk.
	if _, fe := build(t, planVolumeCreate, strings.Replace(mirrorReq, `"sdg"`, `"sdf"`, 1)); fe == nil {
		t.Fatal("a disk given twice must be refused")
	}
	// Not the system disk.
	hostSystemDevs = func() map[string]bool { return map[string]bool{"sdf": true} }
	if _, fe := build(t, planVolumeCreate, mirrorReq); fe == nil || fe.Code != "ESYS" {
		t.Fatalf("the system disk must be refused: %+v", fe)
	}
	hostSystemDevs = func() map[string]bool { return map[string]bool{} }
	// An fstab entry for the folder is refused before anything is erased.
	stubConfigFiles(t, "UUID=old /srv/data ext4 defaults 0 2\n", "")
	if _, fe := build(t, planVolumeCreate, mirrorReq); fe == nil || !strings.Contains(fe.Message, "fstab") {
		t.Fatalf("an fstab entry for the mount point must be refused at preview: %+v", fe)
	}
	stubConfigFiles(t, "", "ARRAY /dev/md0 metadata=1.2 UUID=aa:bb\n")
	// An array configured but not assembled keeps its name.
	p, _ := build(t, planVolumeCreate, mirrorReq)
	if argvs(p)[0][2] != "/dev/md1" {
		t.Fatalf("md0 is configured in mdadm.conf: %v", argvs(p)[0])
	}
}

func TestPlanVolumeCreateStale(t *testing.T) {
	stubVolumeHost(t)
	in := []byte(mirrorReq)
	p1, _ := planVolumeCreate(in)
	hostSignatures = func(dev string) string {
		if dev == "/dev/sdg" {
			return `{"signatures":[{"type":"ext4"}]}`
		}
		return ""
	}
	p2, _ := planVolumeCreate(in)
	if p1.fingerprint(in) == p2.fingerprint(in) {
		t.Fatal("a disk that changed after the preview must make the plan stale")
	}
}
