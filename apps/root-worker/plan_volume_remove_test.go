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
	pd, pp, pb, pl := hostDevsByUUID, hostPvs, hostBusy, hostLookPath
	t.Cleanup(func() { hostDevsByUUID, hostPvs, hostBusy, hostLookPath = pd, pp, pb, pl })
	hostDevsByUUID = func(uuid string) []string {
		if uuid == "fs-1" {
			return []string{"/dev/mapper/data-data"}
		}
		return nil
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
		{"lvremove", "-f", "/dev/data/data"},
		{"vgremove", "-f", "data"},
		{"pvremove", "-f", "/dev/md1"},
		{"mdadm", "--stop", "/dev/md1"},
		{"mdadm", "--zero-superblock", "/dev/sda"},
		{"mdadm", "--zero-superblock", "/dev/sdb"},
		{"update-initramfs", "-u"},
		{"wipefs", "-a", "/dev/sda"},
		{"wipefs", "-a", "/dev/sdb"},
		// Last: until the volume is fully gone, the empty folder stays
		// protected against writes landing on the system disk.
		{"chattr", "-i", "/srv/data"},
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
	// Stop, forget, then erase: a failed erase leaves no stale ARRAY line.
	for i, s := range p.Steps {
		if s.Target == mdadmConfPath && (p.Steps[i-1].Command == nil || p.Steps[i-1].Command[1] != "--stop") {
			t.Fatalf("mdadm.conf is edited right after the array stops: %+v", p.Steps[i-1])
		}
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
	want := [][]string{{"umount", "/srv/data"}, {"lvremove", "-f", "/dev/data/data"}, {"chattr", "-i", "/srv/data"}}
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
	hostDevsByUUID = func(string) []string { return []string{"/dev/sdf"} }
	hostProcMounts = func() string { return "/dev/sdf /srv/data ext4 rw 0 0\n" }
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"umount", "/srv/data"}, {"wipefs", "-a", "/dev/sdf"}, {"chattr", "-i", "/srv/data"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	for _, s := range p.Steps {
		if s.Command != nil && s.Command[0] == "wipefs" && (!s.Destructive || s.Device == nil) {
			t.Fatalf("erasing the disk names it: %+v", s)
		}
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

func TestPlanVolumeRemoveFstabByAnySource(t *testing.T) {
	stubRemoveHost(t)
	hostProcMounts = func() string { return "/dev/sda2 / ext4 rw 0 0\n" }
	// Not mounted, and its entry names the LV path, not the UUID.
	stubConfigFiles(t, "/dev/mapper/data-data /srv/data ext4 defaults 0 2\n", "")
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	found := false
	for _, s := range p.Steps {
		found = found || (s.Target == fstabPath && strings.Contains(s.Diff, "-/dev/mapper/data-data"))
	}
	if !found {
		t.Fatal("the entry by device path is removed too")
	}
	// Mounted elsewhere than its fstab entry says: the entry still goes.
	stubConfigFiles(t, "UUID=fs-1 /mnt/old ext4 defaults 0 2\n", "")
	hostProcMounts = func() string { return "/dev/mapper/data-data /srv/data ext4 rw 0 0\n" }
	p, _ = build(t, planVolumeRemove, removeReq)
	found = false
	for _, s := range p.Steps {
		found = found || (s.Target == fstabPath && strings.Contains(s.Diff, "-UUID=fs-1"))
	}
	if !found {
		t.Fatal("an entry for this filesystem at another mount point is removed")
	}
}

func TestPlanVolumeRemoveDuplicateUUID(t *testing.T) {
	stubRemoveHost(t)
	hostDevsByUUID = func(string) []string { return []string{"/dev/mapper/data-data", "/dev/sdg"} }
	if _, fe := build(t, planVolumeRemove, removeReq); fe == nil || !strings.Contains(fe.Message, "/dev/sdg") {
		t.Fatalf("two filesystems with this UUID: refused, naming them: %+v", fe)
	}
}

func TestPlanVolumeRemoveSambaHolds(t *testing.T) {
	stubRemoveHost(t)
	hostBusy = func(string) []string { return []string{"smbd"} }
	// The caller drops the shares first; their open sessions are closed
	// before the unmount.
	p, fe := build(t, planVolumeRemove, `{"uuid":"fs-1","closeShares":["photos"]}`)
	if fe != nil {
		t.Fatalf("smbd lets go when its shares are dropped first: %+v", fe)
	}
	if got := argvs(p)[0]; !reflect.DeepEqual(got, []string{"smbcontrol", "smbd", "close-share", "photos"}) {
		t.Fatalf("sessions closed before umount: %v", argvs(p))
	}
	hostBusy = func(string) []string { return []string{"smbd", "bash"} }
	if _, fe := build(t, planVolumeRemove, `{"uuid":"fs-1","closeShares":["photos"]}`); fe == nil || strings.Contains(fe.Message, "smbd") || !strings.Contains(fe.Message, "bash") {
		t.Fatalf("other processes still refuse: %+v", fe)
	}
	if _, fe := build(t, planVolumeRemove, `{"uuid":"fs-1","closeShares":["bad name;"]}`); fe == nil {
		t.Fatal("share names are validated")
	}
}

func TestParseFuser(t *testing.T) {
	out := "                     USER        PID ACCESS COMMAND\n" +
		"/srv/data:           root     kernel mount /srv/data\n" +
		"                     theo       1234 ..c.. bash\n" +
		"                     root       2345 F.... smbd\n" +
		"                     root       2346 F.... smbd\n"
	if got := parseFuser(out); !reflect.DeepEqual(got, []string{"bash", "smbd"}) {
		t.Fatalf("processes using the mount: %v", got)
	}
	if got := parseFuser("                     USER        PID ACCESS COMMAND\n/srv/data:           root     kernel mount /srv/data\n"); len(got) != 0 {
		t.Fatalf("an idle mount is not busy: %v", got)
	}
}

func TestPlanVolumeRemoveNamedArrayPV(t *testing.T) {
	stubRemoveHost(t)
	pr := hostRealPath
	t.Cleanup(func() { hostRealPath = pr })
	// LVM reports the PV by the array's name link.
	hostPvs = func() []lvmPV { return []lvmPV{{Name: "/dev/md/data", VGName: "data"}} }
	hostRealPath = func(p string) string {
		if p == "/dev/md/data" {
			return "/dev/md1"
		}
		return p
	}
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatal(fe)
	}
	got := argvs(p)
	found := false
	for _, a := range got {
		found = found || reflect.DeepEqual(a, []string{"mdadm", "--stop", "/dev/md1"})
	}
	if !found {
		t.Fatalf("the array behind /dev/md/data is stopped: %v", got)
	}
}

func TestPlanVolumeRemoveMultiDeviceBtrfs(t *testing.T) {
	stubRemoveHost(t)
	stubConfigFiles(t, "UUID=fs-1 /srv/data btrfs defaults,nofail 0 0\n", "")
	hostDevsByUUID = func(string) []string { return []string{"/dev/sdf", "/dev/sdg"} }
	hostBlkid = func(dev, tag string) string {
		if tag == "TYPE" {
			return "btrfs"
		}
		return ""
	}
	hostProcMounts = func() string { return "/dev/sdf /srv/data btrfs rw 0 0\n" }
	p, fe := build(t, planVolumeRemove, removeReq)
	if fe != nil {
		t.Fatalf("a btrfs on two disks is one volume: %+v", fe)
	}
	want := [][]string{{"umount", "/srv/data"}, {"wipefs", "-a", "/dev/sdf"}, {"wipefs", "-a", "/dev/sdg"}, {"chattr", "-i", "/srv/data"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	if !reflect.DeepEqual(p.Reply["freed"], []string{"/dev/sdf", "/dev/sdg"}) {
		t.Fatalf("both disks are freed: %v", p.Reply["freed"])
	}
	// Two ext4 with one UUID stay a clone: refused.
	hostBlkid = func(dev, tag string) string { return "ext4" }
	if _, fe := build(t, planVolumeRemove, removeReq); fe == nil {
		t.Fatal("a cloned ext4 is refused")
	}
}
