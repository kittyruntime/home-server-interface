package main

import (
	"strings"
	"testing"
)

// stubZfsHost: two free disks sdf and sdg with stable names, ZFS present,
// one pool "tank" already there, nothing mounted under /srv.
func stubZfsHost(t *testing.T) {
	t.Helper()
	stubVolumeHost(t)
	prevL, prevA, prevO, prevM := hostByIDLinks, zfsAvailable, hostOutput, zfsMountTable
	t.Cleanup(func() { hostByIDLinks, zfsAvailable, hostOutput, zfsMountTable = prevL, prevA, prevO, prevM })
	withPoolsFile(t, "")
	hostByIDLinks = func() map[string]string {
		return map[string]string{"ata-WDC_F": "sdf", "ata-WDC_G": "sdg", "ata-WDC_H": "sdh", "wwn-0x1": "sdf"}
	}
	zfsAvailable = func() bool { return true }
	zfsMountTable = func() map[string]string { return map[string]string{"/": "/dev/sda2"} }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		if name == "zpool" && args[0] == "list" {
			return []byte("tank\t1\t1\t1\t1\t0\tONLINE\n"), nil
		}
		return nil, nil
	}
}

func TestPlanZfsPoolCreateMirror(t *testing.T) {
	stubZfsHost(t)
	p, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"mirror","disks":["sdf","sdg"],"compression":"lz4"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	cmd := strings.Join(p.Steps[0].Command, " ")
	want := "zpool create -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl -m /srv/data data mirror /dev/disk/by-id/ata-WDC_F /dev/disk/by-id/ata-WDC_G"
	if cmd != want {
		t.Errorf("command:\n%s\nwant:\n%s", cmd, want)
	}
	if !p.Steps[0].Destructive || len(p.Steps[0].Devices) != 2 {
		t.Errorf("the create step erases and lists both disks: %+v", p.Steps[0])
	}
	if last := p.Steps[len(p.Steps)-1]; last.Target != zfsPoolsPath || !last.Deferred {
		t.Errorf("the new pool is watched: %+v", last)
	}
}

func TestPlanZfsPoolCreateStripeAndRaidz(t *testing.T) {
	stubZfsHost(t)
	p, fe := planZfsPoolCreate([]byte(`{"name":"one","layout":"stripe","disks":["sdf"],"compression":"off"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if cmd := strings.Join(p.Steps[0].Command, " "); !strings.HasSuffix(cmd, "-m /srv/one one /dev/disk/by-id/ata-WDC_F") || !strings.Contains(cmd, "compression=off") {
		t.Errorf("stripe: %s", cmd)
	}
	p, fe = planZfsPoolCreate([]byte(`{"name":"big","layout":"raidz1","disks":["sdf","sdg","sdh"],"compression":"zstd"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if cmd := strings.Join(p.Steps[0].Command, " "); !strings.Contains(cmd, " big raidz1 /dev/disk/by-id/ata-WDC_F") {
		t.Errorf("raidz1: %s", cmd)
	}
}

func TestPlanZfsPoolCreateRefusals(t *testing.T) {
	stubZfsHost(t)
	for in, why := range map[string]string{
		`{"name":"data","layout":"mirror","disks":["sdf"],"compression":"lz4"}`:             "mirror needs 2 disks",
		`{"name":"data","layout":"raidz2","disks":["sdf","sdg","sdh"],"compression":"lz4"}`: "raidz2 needs 4 disks",
		`{"name":"data","layout":"raid5","disks":["sdf","sdg","sdh"],"compression":"lz4"}`:  "unknown layout",
		`{"name":"tank","layout":"stripe","disks":["sdf"],"compression":"lz4"}`:             "a pool with that name exists",
		`{"name":"etc","layout":"stripe","disks":["sdf"],"compression":"lz4"}`:              "a system folder name",
		`{"name":"../x","layout":"stripe","disks":["sdf"],"compression":"lz4"}`:             "an invalid name",
		`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"gzip-99"}`:         "an unknown compression",
		`{"name":"data","layout":"mirror","disks":["sdf","sdf"],"compression":"lz4"}`:       "a disk twice",
		`{"name":"data","layout":"stripe","disks":["../sda"],"compression":"lz4"}`:          "an invalid device",
	} {
		if _, fe := planZfsPoolCreate([]byte(in)); fe == nil {
			t.Errorf("accepted %s (%s)", in, why)
		}
	}
	hostSystemDevs = func() map[string]bool { return map[string]bool{"sdf": true} }
	if _, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"lz4"}`)); fe == nil {
		t.Errorf("the system disk was accepted")
	}
	hostSystemDevs = func() map[string]bool { return map[string]bool{} }
	hostWholeDisk = func(d string) bool { return d != "sdf" }
	if _, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"lz4"}`)); fe == nil {
		t.Errorf("a partition was accepted")
	}
	hostWholeDisk = func(string) bool { return true }
	hostClaimable = func(string) *fsError { return &fsError{Code: "EBUSY", Message: "sdf holds data"} }
	if _, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"lz4"}`)); fe == nil {
		t.Errorf("a disk holding data was accepted")
	}
	hostClaimable = func(string) *fsError { return nil }
	hostExists = func(p string) bool { return p == "/srv/data" }
	hostDirEmpty = func(string) bool { return false }
	if _, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"lz4"}`)); fe == nil {
		t.Errorf("a non-empty /srv/data was accepted")
	}
	hostExists = func(string) bool { return false }
	zfsMountTable = func() map[string]string { return map[string]string{"/": "/dev/sda2", "/srv/data": "/dev/md0"} }
	if _, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"lz4"}`)); fe == nil {
		t.Errorf("a /srv/data already mounted was accepted")
	}
	zfsMountTable = func() map[string]string { return map[string]string{"/": "/dev/sda2"} }
	zfsAvailable = func() bool { return false }
	if _, fe := planZfsPoolCreate([]byte(`{"name":"data","layout":"stripe","disks":["sdf"],"compression":"lz4"}`)); fe == nil {
		t.Errorf("accepted without ZFS")
	}
}

// A pool "tank" on sdf and sdg (partitions 1 and 9, as zpool makes them),
// with tank/media and its child tank/media/films.
func stubTankPool(t *testing.T) {
	t.Helper()
	stubZfsHost(t)
	prevR, prevP := zfsResolve, zfsParentOf
	t.Cleanup(func() { zfsResolve, zfsParentOf = prevR, prevP })
	zfsResolve = func(p string) (string, error) {
		return map[string]string{"/dev/disk/by-id/ata-WDC_1-part1": "/dev/sdf1", "/dev/disk/by-id/ata-WDC_2-part1": "/dev/sdg1"}[p], nil
	}
	zfsParentOf = func(n string) string { return strings.TrimSuffix(n, "1") }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		switch name + " " + args[0] {
		case "zpool list":
			return []byte("tank\t1234567890\t1\t1\t1\t0\tONLINE\n"), nil
		case "zpool status":
			return []byte(zfsFixture(t, "status-mirror-2.2.txt")), nil
		case "zfs list":
			return []byte("tank\t1\t1\t0\t/srv/tank\tyes\tlz4\t1.00x\ton\ntank/media\t1\t1\t0\t/srv/tank/media\tyes\tlz4\t1.00x\ton\ntank/media/films\t1\t1\t0\t/srv/tank/media/films\tyes\tlz4\t1.00x\ton\ntank/docs\t1\t1\t0\t/srv/tank/docs\tyes\tlz4\t1.00x\ton\n"), nil
		case "zfs version":
			return []byte("zfs-2.2.2-1\n"), nil
		}
		return nil, nil
	}
}

func TestPlanZfsPoolDestroyWipesItsDisks(t *testing.T) {
	stubTankPool(t)
	p, fe := planZfsPoolDestroy([]byte(`{"name":"tank"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	var cmds []string
	for _, s := range p.Steps {
		if len(s.Command) > 0 {
			cmds = append(cmds, strings.Join(s.Command, " "))
		}
	}
	want := "zpool destroy tank;wipefs -a /dev/sdf;wipefs -a /dev/sdg"
	if strings.Join(cmds, ";") != want {
		t.Errorf("commands:\n%s\nwant:\n%s", strings.Join(cmds, ";"), want)
	}
	if !p.Steps[0].Destructive || len(p.Steps[0].Devices) != 2 {
		t.Errorf("the destroy step lists the two disks it erases: %+v", p.Steps[0])
	}
	if last := p.Steps[len(p.Steps)-1]; last.Target != zfsPoolsPath {
		t.Errorf("the pool is unwatched: %+v", last)
	}
	if _, fe := planZfsPoolDestroy([]byte(`{"name":"nope"}`)); fe == nil {
		t.Errorf("a pool that does not exist was accepted")
	}
}

func TestPlanZfsDatasetCreate(t *testing.T) {
	stubTankPool(t)
	p, fe := planZfsDatasetCreate([]byte(`{"name":"tank/photos","quota":1000000000,"compression":"zstd"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if cmd := strings.Join(p.Steps[0].Command, " "); cmd != "zfs create -o quota=1000000000 -o compression=zstd tank/photos" {
		t.Errorf("command: %s", cmd)
	}
	p, fe = planZfsDatasetCreate([]byte(`{"name":"tank/media/music","compression":"inherit"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if cmd := strings.Join(p.Steps[0].Command, " "); cmd != "zfs create tank/media/music" {
		t.Errorf("inherited, no quota: %s", cmd)
	}
	for _, in := range []string{
		`{"name":"tank"}`, `{"name":"other/x"}`, `{"name":"tank/../x"}`, `{"name":"tank/a b"}`, `{"name":"tank/media"}`,
		`{"name":"tank/x","quota":-1}`, `{"name":"tank/x","compression":"gzip"}`, `{"name":"tank/nope/x"}`,
	} {
		if _, fe := planZfsDatasetCreate([]byte(in)); fe == nil {
			t.Errorf("accepted %s", in)
		}
	}
}

func TestPlanZfsDatasetSet(t *testing.T) {
	stubTankPool(t)
	p, fe := planZfsDatasetSet([]byte(`{"name":"tank/media","quota":0,"compression":"lz4"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if cmd := strings.Join(p.Steps[0].Command, " "); cmd != "zfs set quota=none compression=lz4 tank/media" {
		t.Errorf("command: %s", cmd)
	}
	if _, fe := planZfsDatasetSet([]byte(`{"name":"tank/nope","quota":0,"compression":"lz4"}`)); fe == nil {
		t.Errorf("a dataset that does not exist was accepted")
	}
}

func TestPlanZfsDatasetDestroy(t *testing.T) {
	stubTankPool(t)
	saveWatched([]watchedPool{{Name: "tank", GUID: "1234567890", Datasets: []watchedDataset{{Name: "tank/docs", MountPoint: "/srv/tank/docs"}, {Name: "tank/media", MountPoint: "/srv/tank/media"}}}})
	p, fe := planZfsDatasetDestroy([]byte(`{"name":"tank/docs"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if cmd := strings.Join(p.Steps[0].Command, " "); cmd != "zfs destroy tank/docs" || !p.Steps[0].Destructive {
		t.Errorf("command: %s", cmd)
	}
	if !strings.Contains(p.Steps[1].Diff, `-        "name": "tank/docs"`) {
		t.Errorf("tank/docs leaves the watched list: %s", p.Steps[1].Diff)
	}
	for _, in := range []string{`{"name":"tank"}`, `{"name":"tank/media"}`, `{"name":"tank/nope"}`} {
		if _, fe := planZfsDatasetDestroy([]byte(in)); fe == nil {
			t.Errorf("accepted %s (the pool itself, a dataset with children, or one that does not exist)", in)
		}
	}
}
