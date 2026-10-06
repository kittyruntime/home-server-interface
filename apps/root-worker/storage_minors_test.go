package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Concurrent writers of one description never collide on a temp file.
func TestSaveDescriptionConcurrent(t *testing.T) {
	stubDescriptionsDir(t)
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/data", Options: fmt.Sprint(i)}})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if d, _ := loadDescriptions(); d["/srv/data"].Mount.Point != "/srv/data" {
		t.Fatalf("readable after concurrent writes: %+v", d)
	}
	if left, _ := filepath.Glob(filepath.Join(storageDescriptionsDir(), "*.tmp*")); len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

const brokenFstab = "# HSI-managed mount: /srv/data\nUUID=fs-1\t/srv/data\text4\tdefaults\t0\t2\n"

func writeBroken(t *testing.T) string {
	t.Helper()
	path := filepath.Join(storageDescriptionsDir(), "srv-data.yaml")
	if err := os.WriteFile(path, []byte("mount: [unclosed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A description edited by hand into invalid YAML is reported, not skipped,
// and HSI writes over it rather than next to it.
func TestBrokenDescriptionReported(t *testing.T) {
	stubDescriptionsDir(t)
	stubConfigFiles(t, brokenFstab, "")
	path := writeBroken(t)
	st := descriptionStatuses()
	if len(st) != 1 || st[0].MountPoint != "/srv/data" || st[0].File != path || len(st[0].Items) != 1 || st[0].Items[0].Kind != "unreadable" {
		t.Fatalf("status: %+v", st)
	}
	if got, err := saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/data"}}); err != nil || got != path {
		t.Fatalf("written over the broken file: %s %v", got, err)
	}
}

func TestRemoveBrokenDescription(t *testing.T) {
	stubDescriptionsDir(t)
	path := writeBroken(t)
	if err := removeDescription("/srv/data"); err != nil {
		t.Fatal(err)
	}
	if fileExists(path) {
		t.Fatal("broken file removed with its volume")
	}
}

func TestAcceptRewritesBroken(t *testing.T) {
	stubDescriptionsDir(t)
	stubConfigFiles(t, brokenFstab, "")
	path := writeBroken(t)
	stubDescribeFn(t, nil)
	p, fe := build(t, planStorageAccept, `{"mountPoint":"/srv/data"}`)
	if fe != nil || p.Steps[0].Target != path {
		t.Fatalf("accept over a broken file: %+v %+v", p, fe)
	}
	if _, fe := build(t, planStorageReapply, `{"mountPoint":"/srv/data"}`); fe == nil || !strings.Contains(fe.Message, "cannot be read") {
		t.Fatalf("reapply explains: %+v", fe)
	}
}

// Re-describing after an array or expand operation keeps the described mount
// options: a hand edit of fstab stays a difference (only mount plans set them).
func TestRedescribeKeepsMountOptions(t *testing.T) {
	stubDescriptionsDir(t)
	_, _ = saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/data", Options: "described"}, Array: &descArray{UUID: "U"}})
	stubDescribeFn(t, nil) // describes options "defaults"
	refreshDescriptions(&opPlan{Redescribe: []string{"/srv/data"}}, time.Now())
	if d, _ := loadDescriptions(); d["/srv/data"].Mount.Options != "described" {
		t.Fatalf("redescribe: %+v", d["/srv/data"].Mount)
	}
	refreshDescriptions(&opPlan{DescribeArrayUUID: "U"}, time.Now())
	if d, _ := loadDescriptions(); d["/srv/data"].Mount.Options != "described" {
		t.Fatalf("array op: %+v", d["/srv/data"].Mount)
	}
	refreshDescriptions(&opPlan{Describe: []string{"/srv/data"}}, time.Now())
	if d, _ := loadDescriptions(); d["/srv/data"].Mount.Options != "defaults" {
		t.Fatalf("mount plan: %+v", d["/srv/data"].Mount)
	}
}

func TestExpandRedescribes(t *testing.T) {
	stubExpandHost(t)
	hostVgFree = func(string) int64 { return 32e9 }
	p, fe := expand(t, "vgFree", "")
	if fe != nil || strings.Join(p.Redescribe, ",") != "/srv/data" || len(p.Describe) != 0 {
		t.Fatalf("%+v %+v", p, fe)
	}
}

// The role of a missing disk tells the dashboard whether starting degraded is at stake.
func TestDriftDiskMissingHasRole(t *testing.T) {
	d := driftDesc()
	d.Disks = append(d.Disks, descDisk{ByID: "/dev/disk/by-id/ata-S", Serial: "S", Role: "spare"})
	l := driftLive()
	l.ArrayDev, l.ArrayMembers, l.MountedOn = "", nil, ""
	l.Connected["S"] = false
	items := diffDescription(d, l)
	last := items[len(items)-1]
	if last.Kind != "disk-missing" || last.Role != "spare" {
		t.Fatalf("role: %+v", items)
	}
	raw, _ := json.Marshal(last)
	if !strings.Contains(string(raw), `"role":"spare"`) {
		t.Fatalf("json: %s", raw)
	}
}

// A cleanly unmounted volume is not drift: the Volumes page offers Mount.
func TestDiffNotMountedAloneIsNotDrift(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.MountedOn = "" }, "", "")
}

func TestReapplyProtectsCreatedMountPoint(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.MountedOn, l.FstabPresent = "", false })
	hostExists = func(string) bool { return false }
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	var cmds []string
	for _, s := range p.Steps {
		cmds = append(cmds, s.Kind+":"+strings.Join(s.Command, " "))
	}
	got := strings.Join(cmds, " | ")
	if !strings.Contains(got, "create: | run:chattr +i /srv/data | ") {
		t.Fatalf("protected before mounting: %s", got)
	}
}

func TestReapplySettlesBeforeMount(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.VGActive, l.MountedOn = false, "" })
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	var cmds []string
	for _, a := range argvs(p) {
		cmds = append(cmds, strings.Join(a, " "))
	}
	if strings.Join(cmds, " | ") != "vgchange -ay data | udevadm settle | mount -o defaults,nofail UUID=fs-1 /srv/data" {
		t.Fatalf("commands: %v", cmds)
	}
}

// After assembling, a clone of the filesystem could appear: the mount checks again.
func TestReapplyMountRefusesCloneAtRun(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.MountedOn = "" })
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	pd, pr := hostDevsByUUID, runArgv
	t.Cleanup(func() { hostDevsByUUID, runArgv = pd, pr })
	hostDevsByUUID = func(string) []string { return []string{"/dev/sdx", "/dev/sdy"} }
	hostBlkid = func(string, string) string { return "ext4" }
	runArgv = func([]string) ([]byte, error) { return nil, errors.New("must not mount") }
	mount := p.Steps[len(p.Steps)-1]
	if _, err := mount.run(); err == nil || !strings.Contains(err.Error(), "clone") {
		t.Fatalf("clone at mount time: %v", err)
	}
}

// A disk without a by-id link is described by its by-path link, not its
// kernel name (which another disk can take after a reboot).
func TestDescribeDiskWithoutByID(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/vdb /srv/data ext4 rw 0 0\n", nil, nil, "")
	pp := hostByPathLinks
	t.Cleanup(func() { hostByPathLinks = pp })
	hostByPathLinks = func() map[string]string { return map[string]string{"pci-0000:00:05.0": "vdb"} }
	d, fe := describeVolume("/srv/data", describeNow)
	if fe != nil {
		t.Fatal(fe)
	}
	if d.Disks[0].ByID != "/dev/disk/by-path/pci-0000:00:05.0" {
		t.Fatalf("by-path: %+v", d.Disks[0])
	}
}

// A disk with a serial is connected wherever it shows up, whatever its links.
func TestCollectLiveConnectedByIdentity(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/sdq /srv/data ext4 rw 0 0\n", nil, nil, "")
	pu, pk, pe := hostUUIDDevices, hostDiskKeys, hostExists
	t.Cleanup(func() { hostUUIDDevices, hostDiskKeys, hostExists = pu, pk, pe })
	hostUUIDDevices = func() string { return "/dev/sdq fs-1\n" }
	hostDiskKeys = func() map[string]bool { return map[string]bool{"S-A": true} }
	hostExists = func(string) bool { return false }
	l := collectLive(storageDescription{Mount: descMount{Point: "/srv/data"}, Filesystem: descFS{UUID: "fs-1"},
		Disks: []descDisk{{ByID: "/dev/disk/by-id/gone", Serial: "S-A"}, {ByID: "/dev/disk/by-id/gone2", Serial: "S-B"}}})
	if !l.Connected["S-A"] || l.Connected["S-B"] {
		t.Fatalf("connected: %+v", l.Connected)
	}
}

func TestDescriptionJSONNames(t *testing.T) {
	raw, _ := json.Marshal(driftDesc())
	for _, k := range []string{`"mount":`, `"point":`, `"byId":`, `"filesystem":`} {
		if !strings.Contains(string(raw), k) {
			t.Fatalf("%s missing in %s", k, raw)
		}
	}
}

// Volumes mounted by systemd after the worker started get a description on
// the next tick.
func TestStorageTickBackfills(t *testing.T) {
	stubDescriptionsDir(t)
	stubConfigFiles(t, brokenFstab, "")
	pm := hostProcMounts
	t.Cleanup(func() { hostProcMounts = pm })
	hostProcMounts = func() string { return "/dev/sdb1 /srv/data ext4 rw 0 0\n" }
	stubExpansions(t)
	hostProcMounts = func() string { return "/dev/sdb1 /srv/data ext4 rw 0 0\n" }
	described := stubDescribeFn(t, nil)
	storageTick(time.Now())
	if strings.Join(*described, ",") != "/srv/data" {
		t.Fatalf("backfilled on the tick: %v", *described)
	}
}
