package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func zfsFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "zfs", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func leaves(v zfsVdev) []zfsVdev {
	if len(v.Children) == 0 {
		return []zfsVdev{v}
	}
	var out []zfsVdev
	for _, c := range v.Children {
		out = append(out, leaves(c)...)
	}
	return out
}

func TestParseZpoolList(t *testing.T) {
	pools := parseZpoolList(zfsFixture(t, "list-2.2.txt"))
	if len(pools) != 2 {
		t.Fatalf("pools = %d, want 2", len(pools))
	}
	p := pools[0]
	if p.Name != "tank" || p.GUID != "1234567890" || p.Size != 8001563222016 || p.Frag != 3 || p.State != "ONLINE" {
		t.Errorf("tank = %+v", p)
	}
	if pools[1].Frag != 0 {
		t.Errorf("a '-' fragmentation reads 0, got %d", pools[1].Frag)
	}
}

func TestParseZpoolStatusMirror(t *testing.T) {
	st := parseZpoolStatus(zfsFixture(t, "status-mirror-2.2.txt"))
	tank, ok := st["tank"]
	if !ok || len(tank.Vdevs) != 1 {
		t.Fatalf("tank = %+v", st)
	}
	m := tank.Vdevs[0]
	if m.Type != "mirror" || m.Name != "mirror-0" || len(m.Children) != 2 {
		t.Fatalf("mirror = %+v", m)
	}
	if l := m.Children[0]; l.Type != "disk" || l.Path != "/dev/disk/by-id/ata-WDC_1-part1" || l.Read+l.Write+l.Checksum != 0 {
		t.Errorf("leaf = %+v", l)
	}
	want := zfsScan{Kind: "scrub", State: "finished", End: "Sun Nov 22 00:24:01 2026"}
	if tank.Scan.Kind != want.Kind || tank.Scan.State != want.State || tank.Scan.End != want.End || tank.Scan.Repaired != 0 || tank.Scan.Errors != 0 {
		t.Errorf("scan = %+v", tank.Scan)
	}
}

func TestParseZpoolStatusDegradedResilver(t *testing.T) {
	tank := parseZpoolStatus(zfsFixture(t, "status-degraded-resilver-2.3.txt"))["tank"]
	ls := leaves(tank.Vdevs[0])
	var unavail, cksum bool
	for _, l := range ls {
		if l.State == "UNAVAIL" && l.Path == "/dev/sdd1" {
			unavail = true
		}
		if l.Path == "/dev/sdc1" && l.Checksum == 12 {
			cksum = true
		}
	}
	if !unavail || !cksum || len(ls) != 4 {
		t.Errorf("leaves = %+v", ls)
	}
	if tank.Vdevs[0].Type != "raidz1" || tank.Vdevs[0].Children[2].Type != "replacing" {
		t.Errorf("types = %s, %s", tank.Vdevs[0].Type, tank.Vdevs[0].Children[2].Type)
	}
	s := tank.Scan
	if s.Kind != "resilver" || s.State != "running" || s.Percent == nil || *s.Percent != 42.5 {
		t.Errorf("scan = %+v", s)
	}
}

func TestParseZpoolStatusMulti(t *testing.T) {
	st := parseZpoolStatus(zfsFixture(t, "status-raidz2-multi.txt"))
	big := st["big"]
	var types []string
	for _, v := range big.Vdevs {
		types = append(types, v.Type)
	}
	if strings.Join(types, ",") != "raidz2,raidz2,log,cache" {
		t.Errorf("top-level types = %v", types)
	}
	if got := big.Vdevs[1].Children[3].Read; got != 1200 {
		t.Errorf("1.2K read errors = %d", got)
	}
	if big.Scan.Errors != 3 || big.Scan.Repaired != 1572864 {
		t.Errorf("scan = %+v", big.Scan)
	}
	solo := st["solo"]
	if len(solo.Vdevs) != 1 || solo.Vdevs[0].Type != "disk" || solo.Scan.Kind != "none" {
		t.Errorf("solo = %+v", solo)
	}
}

func TestParseZfsList(t *testing.T) {
	ds := parseZfsList(zfsFixture(t, "zfs-list.txt"))
	if len(ds) != 4 {
		t.Fatalf("datasets = %d", len(ds))
	}
	m := ds[1]
	if m.Name != "tank/media" || m.Pool != "tank" || m.Used != 2200000000000 || m.Quota != 0 || m.MountPoint != "/tank/media" || !m.Mounted || m.Ratio != 1.31 || m.Compression != "lz4" {
		t.Errorf("tank/media = %+v", m)
	}
	if ds[2].MountPoint != "none" || ds[2].Mounted || ds[2].Quota != 500000000000 || ds[2].Ratio != 1 {
		t.Errorf("tank/vm = %+v", ds[2])
	}
	if ds[3].Quota != 0 {
		t.Errorf("a '-' quota reads 0")
	}
}

func TestZfsDatasetIsVolume(t *testing.T) {
	for mp, want := range map[string]bool{"/tank/media": true, "none": false, "legacy": false, "-": false, "": false} {
		if got := zfsDatasetIsVolume(zfsDataset{MountPoint: mp}); got != want {
			t.Errorf("%q: %v, want %v", mp, got, want)
		}
	}
}

func TestParseZpoolImport(t *testing.T) {
	ps := parseZpoolImport(zfsFixture(t, "import-scan.txt"))
	if len(ps) != 2 {
		t.Fatalf("importable = %d", len(ps))
	}
	b := ps[0]
	if b.Name != "backup" || b.GUID != "987654321" || b.State != "ONLINE" || len(b.Vdevs) != 1 || len(b.Vdevs[0].Children) != 2 {
		t.Errorf("backup = %+v", b)
	}
	if ps[1].State != "UNAVAIL" || !strings.Contains(ps[1].Status, "missing from the system") {
		t.Errorf("old = %+v", ps[1])
	}
}

func TestParseZfsVersion(t *testing.T) {
	if v := parseZfsVersion(zfsFixture(t, "version-2.2.txt")); v != "2.2.2" {
		t.Errorf("2.2: %q", v)
	}
	if v := parseZfsVersion(zfsFixture(t, "version-2.3.txt")); v != "2.3.1" {
		t.Errorf("2.3: %q", v)
	}
}

func TestWholeDiskOf(t *testing.T) {
	links := map[string]string{"/dev/disk/by-id/ata-WDC_1-part1": "/dev/sdb1", "/dev/disk/by-id/ata-WDC_2": "/dev/sdc"}
	resolve := func(p string) (string, error) {
		if r, ok := links[p]; ok {
			return r, nil
		}
		return p, nil
	}
	parents := map[string]string{"sdb1": "sdb", "sdc1": "sdc", "nvme0n1p2": "nvme0n1"}
	parentOf := func(n string) string { return parents[n] }
	for in, want := range map[string]string{
		"/dev/disk/by-id/ata-WDC_1-part1": "sdb",
		"/dev/sdc1":                       "sdc",
		"/dev/nvme0n1p2":                  "nvme0n1",
		"/dev/disk/by-id/ata-WDC_2":       "sdc",
	} {
		if got := wholeDiskOf(in, resolve, parentOf); got != want {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}
}

func TestZfsSnapshotUnavailable(t *testing.T) {
	prevA, prevO := zfsAvailable, hostOutput
	t.Cleanup(func() { zfsAvailable, hostOutput = prevA, prevO })
	zfsAvailable = func() bool { return false }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		t.Fatalf("no command may run without ZFS, ran %s", name)
		return nil, nil
	}
	if info := zfsSnapshot(); info.Available || len(info.Pools) != 0 {
		t.Errorf("info = %+v", info)
	}
}

func TestZfsSnapshotFillsDisks(t *testing.T) {
	prevA, prevO, prevR, prevP := zfsAvailable, hostOutput, zfsResolve, zfsParentOf
	t.Cleanup(func() { zfsAvailable, hostOutput, zfsResolve, zfsParentOf = prevA, prevO, prevR, prevP })
	zfsAvailable = func() bool { return true }
	out := map[string]string{
		"zfs version":  "version-2.2.txt",
		"zpool list":   "list-2.2.txt",
		"zpool status": "status-mirror-2.2.txt",
		"zfs list":     "zfs-list.txt",
	}
	hostOutput = func(name string, args ...string) ([]byte, error) {
		return []byte(zfsFixture(t, out[name+" "+args[0]])), nil
	}
	zfsResolve = func(p string) (string, error) {
		return map[string]string{"/dev/disk/by-id/ata-WDC_1-part1": "/dev/sdb1", "/dev/disk/by-id/ata-WDC_2-part1": "/dev/sdc1"}[p], nil
	}
	zfsParentOf = func(n string) string { return strings.TrimSuffix(n, "1") }
	info := zfsSnapshot()
	if !info.Available || info.Version != "2.2.2" || len(info.Pools) != 2 || len(info.Datasets) != 4 {
		t.Fatalf("info = %+v", info)
	}
	ls := leaves(info.Pools[0].Vdevs[0])
	if ls[0].Disk != "sdb" || ls[1].Disk != "sdc" {
		t.Errorf("disks = %q %q", ls[0].Disk, ls[1].Disk)
	}
	if info.Pools[0].Scan.Kind != "scrub" {
		t.Errorf("status not attached: %+v", info.Pools[0].Scan)
	}
}

func mountsOf(m map[string][2]string) func(string) (string, bool, bool) {
	return func(mp string) (string, bool, bool) {
		e, ok := m[mp]
		return e[0], e[1] == "ro", ok
	}
}

var tankWatched = []watchedPool{{Name: "tank", GUID: "123", Datasets: []watchedDataset{{Name: "tank/media", MountPoint: "/tank/media"}, {Name: "tank/docs", MountPoint: "/tank/docs"}}}}

func TestZfsGuardIgnoresUnwatched(t *testing.T) {
	pools := []zfsPool{{Name: "other", GUID: "9"}}
	if got := zfsGuardStates(nil, pools, nil, mountsOf(nil)); len(got) != 0 {
		t.Errorf("an unwatched pool is not guarded: %+v", got)
	}
}

func TestZfsGuardMissingPool(t *testing.T) {
	got := zfsGuardStates(tankWatched, nil, nil, mountsOf(nil))
	if len(got) != 2 || got[0].State != "missing" || got[1].State != "missing" || got[0].UUID != "zfs:123:tank/media" || got[0].MountPoint != "/tank/media" {
		t.Errorf("states = %+v", got)
	}
}

func TestZfsGuardWrongAndReadonly(t *testing.T) {
	pools := []zfsPool{{Name: "tank", GUID: "123"}}
	got := zfsGuardStates(tankWatched, pools, nil, mountsOf(map[string][2]string{
		"/tank/media": {"/dev/sdz1", "rw"},
		"/tank/docs":  {"tank/docs", "ro"},
	}))
	if got[0].State != "wrong" || got[1].State != "readonly" {
		t.Errorf("states = %+v", got)
	}
	got = zfsGuardStates(tankWatched, pools, nil, mountsOf(map[string][2]string{"/tank/media": {"tank/media", "rw"}}))
	if got[0].State != "ok" || got[1].State != "missing" {
		t.Errorf("states = %+v", got)
	}
}

func withPoolsFile(t *testing.T, content string) {
	t.Helper()
	prev := zfsPoolsPath
	zfsPoolsPath = filepath.Join(t.TempDir(), "zfs-pools.json")
	t.Cleanup(func() { zfsPoolsPath = prev })
	if content != "" {
		if err := os.WriteFile(zfsPoolsPath, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPlanZfsImportSteps(t *testing.T) {
	withPoolsFile(t, "")
	p, fe := planZfsImport([]byte(`{"guid":"987654321","name":"backup"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if len(p.Steps) != 2 || strings.Join(p.Steps[0].Command, " ") != "zpool import -d /dev/disk/by-id 987654321 backup" {
		t.Fatalf("steps = %+v", p.Steps)
	}
	if !p.Steps[1].Deferred || p.Steps[1].Target != zfsPoolsPath {
		t.Errorf("second step = %+v", p.Steps[1])
	}
}

func TestPlanZfsWatchDiff(t *testing.T) {
	withPoolsFile(t, "")
	prevO, prevA := hostOutput, zfsAvailable
	t.Cleanup(func() { hostOutput, zfsAvailable = prevO, prevA })
	zfsAvailable = func() bool { return true }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		switch name + " " + args[0] {
		case "zpool list":
			return []byte(zfsFixture(t, "list-2.2.txt")), nil
		case "zfs list":
			return []byte(zfsFixture(t, "zfs-list.txt")), nil
		}
		return nil, nil
	}
	p, fe := planZfsWatch([]byte(`{"name":"tank"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	d := p.Steps[0].Diff
	if !strings.Contains(d, `"name": "tank"`) || !strings.Contains(d, `"guid": "1234567890"`) || !strings.Contains(d, `"mountPoint": "/tank/media"`) || strings.Contains(d, "tank/vm") {
		t.Errorf("diff = %s", d)
	}
	if _, err := p.Steps[0].run(); err != nil {
		t.Fatal(err)
	}
	if w := loadWatchedPools(); len(w) != 1 || w[0].GUID != "1234567890" || len(w[0].Datasets) != 2 {
		t.Errorf("watched = %+v", w)
	}
	u, fe := planZfsUnwatch([]byte(`{"name":"tank"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if _, err := u.Steps[0].run(); err != nil {
		t.Fatal(err)
	}
	if w := loadWatchedPools(); len(w) != 0 {
		t.Errorf("after unwatch: %+v", w)
	}
}

func TestPlanZfsImportRejectsBadInput(t *testing.T) {
	for _, in := range []string{`{"guid":"12a","name":"x"}`, `{"guid":"1","name":"../x"}`, `{"guid":"1","name":""}`} {
		if _, fe := planZfsImport([]byte(in)); fe == nil {
			t.Errorf("%s accepted", in)
		}
	}
	if _, fe := planZfsWatch([]byte(`{"name":"nope"}`)); fe == nil {
		t.Errorf("watching a pool that is not imported is refused")
	}
}
