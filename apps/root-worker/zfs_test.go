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
