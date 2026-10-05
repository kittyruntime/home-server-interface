package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// stubConfigFiles points fstab and mdadm.conf at temp files for the test.
func stubConfigFiles(t *testing.T, fstab, mdadm string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	f, m := filepath.Join(dir, "fstab"), filepath.Join(dir, "mdadm.conf")
	if err := os.WriteFile(f, []byte(fstab), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m, []byte(mdadm), 0644); err != nil {
		t.Fatal(err)
	}
	pf, pm := fstabPath, mdadmConfPath
	fstabPath, mdadmConfPath = f, m
	t.Cleanup(func() { fstabPath, mdadmConfPath = pf, pm })
	return f, m
}

func stubMountHost(t *testing.T) {
	stubHost(t)
	pe, pb, ps, pr, pp := hostExists, hostBlkid, hostMountSources, hostMdBrief, hostPrepareRoot
	t.Cleanup(func() { hostExists, hostBlkid, hostMountSources, hostMdBrief, hostPrepareRoot = pe, pb, ps, pr, pp })
	hostExists = func(string) bool { return true }
	hostBlkid = func(dev, tag string) string {
		if tag == "UUID" {
			return "uuid-" + strings.TrimPrefix(dev, "/dev/")
		}
		return "ext4"
	}
	hostMountSources = func(string) []string { return []string{"/dev/sdb1", "UUID=uuid-sdb1"} }
	hostMdBrief = func(string) (string, error) { return "ARRAY /dev/md0 metadata=1.2 UUID=aa:bb", nil }
	hostPrepareRoot = func(string, string, bool) []string { return nil }
}

func stepKinds(p *opPlan) []string {
	var k []string
	for _, s := range p.Steps {
		k = append(k, s.Kind)
	}
	return k
}

func TestPlanMountPersist(t *testing.T) {
	stubMountHost(t)
	fstab, _ := stubConfigFiles(t, "UUID=root / ext4 defaults 0 1\n", "")
	hostExists = func(string) bool { return false }
	p, fe := build(t, planMount, `{"device":"sdb1","mountpoint":"/mnt/data","persist":true,"access":"shared","ownerUser":"alice"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if got := stepKinds(p); !reflect.DeepEqual(got, []string{"create", "run", "run", "update", "permissions"}) {
		t.Fatalf("kinds %v", got)
	}
	if !reflect.DeepEqual(argvs(p), [][]string{{"chattr", "+i", "/mnt/data"}, {"mount", "-o", "defaults", "/dev/sdb1", "/mnt/data"}}) {
		t.Fatalf("argvs %v", argvs(p))
	}
	diff := p.Steps[3].Diff
	if !strings.Contains(diff, "+# HSI-managed mount: /mnt/data") || !strings.Contains(diff, "+UUID=uuid-sdb1\t/mnt/data\text4\tdefaults,nofail,x-systemd.device-timeout=10s\t0\t2") {
		t.Fatalf("fstab diff:\n%s", diff)
	}
	// The fstab is only written when the plan runs.
	if b, _ := os.ReadFile(fstab); strings.Contains(string(b), "/mnt/data") {
		t.Fatal("building the plan wrote fstab")
	}
	hostPrepareRoot = func(string, string, bool) []string { return []string{"volume already holds data"} }
	var ran [][]string
	runArgv = func(argv []string) ([]byte, error) { ran = append(ran, argv); return nil, nil }
	dir := t.TempDir()
	p.Steps[0].run = func() (string, error) { return "", os.MkdirAll(filepath.Join(dir, "mnt"), 0755) }
	res, ok, warnings := p.execute()
	if !ok || len(warnings) != 1 || res[4].Status != "warning" {
		t.Fatalf("ok=%v warnings=%v res=%+v", ok, warnings, res)
	}
	if !reflect.DeepEqual(ran, argvs(p)) {
		t.Fatalf("ran %v", ran)
	}
	if b, _ := os.ReadFile(fstab); !strings.Contains(string(b), "UUID=uuid-sdb1\t/mnt/data") {
		t.Fatalf("fstab not written:\n%s", b)
	}
}

func TestPlanMountTransientAndRefusals(t *testing.T) {
	stubMountHost(t)
	stubConfigFiles(t, "UUID=other /mnt/data ext4 defaults 0 2\n", "")
	p, fe := build(t, planMount, `{"device":"sdb1","mountpoint":"/mnt/data"}`)
	if fe != nil || !reflect.DeepEqual(stepKinds(p), []string{"run"}) {
		t.Fatalf("transient mount: %v %v", fe, stepKinds(p))
	}
	// An admin entry for the same mount point is refused before mounting.
	_, fe = build(t, planMount, `{"device":"sdb1","mountpoint":"/mnt/data","persist":true}`)
	wantErr(t, fe, "ERR")
	_, fe = build(t, planMount, `{"device":"sdb1","mountpoint":"/etc"}`)
	wantErr(t, fe, "ESYS")
	_, fe = build(t, planMount, `{"device":"sdb1","mountpoint":"/mnt/a b"}`)
	wantErr(t, fe, "ERR")
}

func TestPlanUmount(t *testing.T) {
	stubMountHost(t)
	conf := "UUID=root / ext4 defaults 0 1\n# HSI-managed mount: /mnt/data\nUUID=uuid-sdb1\t/mnt/data\text4\tdefaults\t0\t2\n"
	stubConfigFiles(t, conf, "")
	p, fe := build(t, planUmount, `{"mountpoint":"/mnt/data","removeFromFstab":true}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if !reflect.DeepEqual(stepKinds(p), []string{"run", "update", "run"}) || !strings.Contains(p.Steps[1].Diff, "-# HSI-managed mount: /mnt/data") {
		t.Fatalf("kinds %v diff:\n%s", stepKinds(p), p.Steps[1].Diff)
	}
	if p.Steps[2].OnFailure != "warn" || !reflect.DeepEqual(p.Steps[2].Command, []string{"chattr", "-i", "/mnt/data"}) {
		t.Fatalf("unprotect step %+v", p.Steps[2])
	}
	assertParity(t, p)
	p, _ = build(t, planUmount, `{"mountpoint":"/mnt/data"}`)
	if !reflect.DeepEqual(stepKinds(p), []string{"run"}) {
		t.Fatalf("plain umount kinds %v", stepKinds(p))
	}
	_, fe = build(t, planUmount, `{"mountpoint":"/"}`)
	wantErr(t, fe, "ESYS")
}

func TestPlanRaidCreate(t *testing.T) {
	stubMountHost(t)
	_, mdadm := stubConfigFiles(t, "", "HOMEHOST <system>\n")
	p, fe := build(t, planRaidCreate, `{"name":"md0","level":1,"devices":["sdb","sdc"]}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if !reflect.DeepEqual(argvs(p)[0], []string{"mdadm", "--create", "/dev/md0", "--level", "1", "--raid-devices", "2", "--run", "/dev/sdb", "/dev/sdc"}) || !p.Steps[0].Destructive {
		t.Fatalf("create step %v", argvs(p))
	}
	if !p.Steps[1].Deferred || p.Steps[1].Kind != "update" || p.Steps[1].OnFailure != "warn" {
		t.Fatalf("mdadm.conf step %+v", p.Steps[1])
	}
	if p.Steps[2].Command[0] != "update-initramfs" {
		t.Fatalf("initramfs step %+v", p.Steps[2])
	}
	runArgv = func(argv []string) ([]byte, error) { return nil, nil }
	res, ok, _ := p.execute()
	if !ok || !strings.Contains(res[1].Detail, "+ARRAY /dev/md0 metadata=1.2 UUID=aa:bb") {
		t.Fatalf("deferred diff not reported: %+v", res)
	}
	if b, _ := os.ReadFile(mdadm); !strings.Contains(string(b), "ARRAY /dev/md0") {
		t.Fatalf("mdadm.conf not written:\n%s", b)
	}
	if p.Reply["device"] != "/dev/md0" {
		t.Fatalf("reply %v", p.Reply)
	}
	stubMountHost(t)
	_, fe = build(t, planRaidCreate, `{"name":"md0","level":5,"devices":["sdb","sdc"]}`)
	wantErr(t, fe, "ERR")
	hostLookPath = func(string) bool { return false }
	_, fe = build(t, planRaidCreate, `{"name":"md0","level":1,"devices":["sdb","sdc"]}`)
	wantErr(t, fe, "ENOTOOL")
}

func TestPlanRaidStop(t *testing.T) {
	stubMountHost(t)
	fstab := "UUID=root / ext4 defaults 0 1\n# HSI-managed mount: /mnt/r\nUUID=uuid-md0\t/mnt/r\text4\tdefaults\t0\t2\n"
	stubConfigFiles(t, fstab, "ARRAY /dev/md0 metadata=1.2 UUID=aa:bb\n")
	hostMdDetail = func(string) (string, error) {
		return "/dev/md0:\n           UUID : aa:bb\n    Number   Major   Minor   RaidDevice State\n       0       8       16        0      active sync   /dev/sdb\n       1       8       32        1      active sync   /dev/sdc\n", nil
	}
	p, fe := build(t, planRaidStop, `{"name":"md0"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"mdadm", "--stop", "/dev/md0"}, {"mdadm", "--zero-superblock", "/dev/sdb"}, {"mdadm", "--zero-superblock", "/dev/sdc"}, {"update-initramfs", "-u"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("argvs %v", argvs(p))
	}
	for _, s := range p.Steps[1:] {
		if s.OnFailure != "warn" {
			t.Fatalf("steps after stop are warnings: %+v", s)
		}
	}
	if !p.Steps[1].Destructive || p.Steps[1].Device.Path != "/dev/sdb" {
		t.Fatalf("zero-superblock step %+v", p.Steps[1])
	}
	var fstabDiff, mdDiff string
	for _, s := range p.Steps {
		if s.Kind == "update" && s.Target == fstabPath {
			fstabDiff = s.Diff
		}
		if s.Kind == "update" && s.Target == mdadmConfPath {
			mdDiff = s.Diff
		}
	}
	if !strings.Contains(fstabDiff, "-UUID=uuid-md0") || !strings.Contains(mdDiff, "-ARRAY /dev/md0") {
		t.Fatalf("diffs:\n%s\n%s", fstabDiff, mdDiff)
	}
	// Zeroing a member failing is only a warning, as today.
	runArgv = func(argv []string) ([]byte, error) {
		if argv[1] == "--zero-superblock" {
			return []byte("busy"), os.ErrPermission
		}
		return nil, nil
	}
	_, ok, warnings := p.execute()
	if !ok || len(warnings) != 2 {
		t.Fatalf("ok=%v warnings=%v", ok, warnings)
	}
	hostProcMounts = func() string { return "/dev/md0 /mnt/r ext4 rw 0 0\n" }
	_, fe = build(t, planRaidStop, `{"name":"md0"}`)
	wantErr(t, fe, "EMNT")
}

func TestPlanRaidStopFingerprintIgnoresResyncProgress(t *testing.T) {
	stubMountHost(t)
	stubConfigFiles(t, "", "ARRAY /dev/md0 metadata=1.2 UUID=aa:bb\n")
	detail := func(pct, events string) string {
		return "/dev/md0:\n     Raid Level : raid1\n  Resync Status : " + pct + "% complete\n         Events : " + events +
			"\n           UUID : aa:bb\n    Number   Major   Minor   RaidDevice State\n       0       8       16        0      active sync   /dev/sdb\n       1       8       32        1      active sync   /dev/sdc\n"
	}
	in := json.RawMessage(`{"name":"md0"}`)
	hostMdDetail = func(string) (string, error) { return detail("12", "40"), nil }
	p1, _ := planRaidStop(in)
	hostMdDetail = func(string) (string, error) { return detail("13", "41"), nil }
	p2, _ := planRaidStop(in)
	if p1.fingerprint(in) != p2.fingerprint(in) {
		t.Fatal("resync progress must not make the plan stale")
	}
	hostMdDetail = func(string) (string, error) {
		return strings.Replace(detail("13", "41"), "/dev/sdc", "/dev/sdd", 1), nil
	}
	p3, _ := planRaidStop(in)
	if p3.fingerprint(in) == p1.fingerprint(in) {
		t.Fatal("a different member must make the plan stale")
	}
}

func TestPlanRaidCreateNamesEveryMember(t *testing.T) {
	stubMountHost(t)
	stubConfigFiles(t, "", "")
	p, fe := build(t, planRaidCreate, `{"name":"md0","level":5,"devices":["sdb","sdc","sdd"]}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if n := len(p.Steps[0].Devices); n != 3 || p.Steps[0].Devices[2].Path != "/dev/sdd" {
		t.Fatalf("all erased devices must be named, got %+v", p.Steps[0].Devices)
	}
}

// lsblk names a logical volume "vg-lv": its node is /dev/mapper/vg-lv.
func TestPlanMountLogicalVolumeByLsblkName(t *testing.T) {
	stubMountHost(t)
	stubConfigFiles(t, "", "")
	hostExists = func(p string) bool { return p != "/dev/oldvg-files" && p != "/srv/files" }
	p, fe := build(t, planMount, `{"device":"oldvg-files","mountpoint":"/srv/files","persist":false}`)
	if fe != nil {
		t.Fatal(fe)
	}
	got := argvs(p)
	if last := got[len(got)-1]; last[len(last)-2] != "/dev/mapper/oldvg-files" {
		t.Fatalf("mounts the mapper node: %v", got)
	}
}

// Mounting over a folder where another volume is mounted would hide it.
func TestPlanMountRefusesAnOccupiedMountPoint(t *testing.T) {
	stubMountHost(t)
	stubConfigFiles(t, "", "")
	hostProcMounts = func() string { return "/dev/sda2 / ext4 rw 0 0\n/dev/mapper/data-data /srv/data ext4 rw 0 0\n" }
	if _, fe := build(t, planMount, `{"device":"sdb1","mountpoint":"/srv/data"}`); fe == nil || fe.Code != "EBUSY" || !strings.Contains(fe.Message, "/srv/data") {
		t.Fatalf("an occupied mount point is refused: %+v", fe)
	}
}
