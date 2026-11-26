package main

import (
	"strings"
	"testing"
)

// growHost: tank with the given zpool status body, expandsize and ZFS version.
func growHost(t *testing.T, body, expand, version string) {
	t.Helper()
	stubTankPool(t)
	inner := hostOutput
	hostOutput = func(name string, args ...string) ([]byte, error) {
		j := name + " " + strings.Join(args, " ")
		switch {
		case strings.HasPrefix(j, "zpool status"):
			return []byte(poolStatus("tank", body)), nil
		case strings.HasPrefix(j, "zpool list") && strings.Contains(j, "expandsize"):
			return []byte("tank\t" + expand + "\n"), nil
		case j == "zfs version":
			return []byte("zfs-" + version + "-1\n"), nil
		case strings.Contains(j, "feature@raidz_expansion"):
			return []byte("enabled\n"), nil
		}
		return inner(name, args...)
	}
}

const mirrorBody = "\t  mirror-0 ONLINE 0 0 0\n\t    /dev/sdf1 ONLINE 0 0 0\n\t    /dev/sdg1 ONLINE 0 0 0\n"
const raidzBody = "\t  raidz1-0 ONLINE 0 0 0\n\t    /dev/sdf1 ONLINE 0 0 0\n\t    /dev/sdg1 ONLINE 0 0 0\n\t    /dev/sdj1 ONLINE 0 0 0\n"

func TestPoolDataLayout(t *testing.T) {
	growHost(t, mirrorBody+"\t  mirror-1 ONLINE 0 0 0\n\t    /dev/sdk1 ONLINE 0 0 0\n\t    /dev/sdl1 ONLINE 0 0 0\n\tlogs\n\t  /dev/nvme0n1p1 ONLINE 0 0 0\n", "0", "2.2.2")
	p, _ := importedPool("tank")
	if layout, width, ok := poolDataLayout(p.Vdevs); !ok || layout != "mirror" || width != 2 {
		t.Errorf("%s %d %v", layout, width, ok)
	}
	growHost(t, mirrorBody+"\t  raidz1-1 ONLINE 0 0 0\n\t    /dev/sdk1 ONLINE 0 0 0\n\t    /dev/sdl1 ONLINE 0 0 0\n\t    /dev/sdm1 ONLINE 0 0 0\n", "0", "2.2.2")
	p, _ = importedPool("tank")
	if _, _, ok := poolDataLayout(p.Vdevs); ok {
		t.Error("a pool mixing layouts has no single layout to add")
	}
	growHost(t, "\t  /dev/sdf1 ONLINE 0 0 0\n", "0", "2.2.2")
	p, _ = importedPool("tank")
	if layout, width, ok := poolDataLayout(p.Vdevs); !ok || layout != "stripe" || width != 1 {
		t.Errorf("single disk: %s %d %v", layout, width, ok)
	}
}

func TestPlanZfsPoolAdd(t *testing.T) {
	growHost(t, mirrorBody, "0", "2.2.2")
	p, fe := planZfsPoolAdd([]byte(`{"pool":"tank","disks":["sdh","sdi"]}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if got := commands(p); got != "zpool add -o ashift=12 tank mirror /dev/disk/by-id/ata-WDC_H /dev/sdi" {
		t.Errorf("command: %s", got)
	}
	if !p.Steps[0].Destructive || len(p.Steps[0].Devices) != 2 || !strings.Contains(p.Steps[0].Summary, "cannot be removed") {
		t.Errorf("%+v", p.Steps[0])
	}
	for in, why := range map[string]string{
		`{"pool":"tank","disks":["sdh"]}`:             "a mirror of one disk",
		`{"pool":"tank","disks":["sdh","sdh"]}`:       "a disk twice",
		`{"pool":"tank","disks":["sdh","sdi","sdj"]}`: "a wider mirror than the pool's",
		`{"pool":"nope","disks":["sdh","sdi"]}`:       "a pool not imported",
		`{"pool":"tank","disks":["sdh","../x"]}`:      "an invalid device",
	} {
		if _, fe := planZfsPoolAdd([]byte(in)); fe == nil {
			t.Errorf("accepted %s (%s)", in, why)
		}
	}
	hostSystemDevs = func() map[string]bool { return map[string]bool{"sdi": true} }
	if _, fe := planZfsPoolAdd([]byte(`{"pool":"tank","disks":["sdh","sdi"]}`)); fe == nil {
		t.Error("the system disk was accepted")
	}
}

func TestPlanZfsPoolExpand(t *testing.T) {
	growHost(t, mirrorBody, "1000000000", "2.2.2")
	p, fe := planZfsPoolExpand([]byte(`{"pool":"tank"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if got := commands(p); got != "zpool set autoexpand=on tank;zpool online -e tank /dev/sdf1;zpool online -e tank /dev/sdg1" {
		t.Errorf("commands: %s", got)
	}
	growHost(t, mirrorBody, "0", "2.2.2")
	if _, fe := planZfsPoolExpand([]byte(`{"pool":"tank"}`)); fe == nil {
		t.Error("a pool with nothing to gain was accepted")
	}
}

func TestPlanZfsPoolAttach(t *testing.T) {
	growHost(t, raidzBody, "0", "2.3.1")
	p, fe := planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"raidz1-0","disk":"sdh"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if got := commands(p); got != "zpool attach tank raidz1-0 /dev/disk/by-id/ata-WDC_H" || !p.Steps[0].Destructive {
		t.Errorf("raidz: %s", got)
	}
	growHost(t, raidzBody, "0", "2.2.2")
	if _, fe := planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"raidz1-0","disk":"sdh"}`)); fe == nil || !strings.Contains(fe.Message, "2.3") {
		t.Errorf("raidz expansion before OpenZFS 2.3 was accepted: %v", fe)
	}
	// A mirror gains a copy: attached to its first disk, any version.
	growHost(t, mirrorBody, "0", "2.2.2")
	p, fe = planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"mirror-0","disk":"sdh"}`))
	if fe != nil || commands(p) != "zpool attach tank /dev/sdf1 /dev/disk/by-id/ata-WDC_H" {
		t.Errorf("mirror: %v %v", p, fe)
	}
	if _, fe := planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"mirror-9","disk":"sdh"}`)); fe == nil {
		t.Error("a vdev not in the pool was accepted")
	}
}

func TestParseExpandProgress(t *testing.T) {
	st := parseZpoolStatus("  pool: tank\n state: ONLINE\nexpand: expansion of raidz1-0 in progress since Wed Nov 25 10:00:00 2026\n\t1.20G / 3.00G copied at 100M/s, 40.00% done, 00:00:18 to go\nconfig:\n\n\tNAME STATE READ WRITE CKSUM\n\ttank ONLINE 0 0 0\n" + raidzBody + "\nerrors: No known data errors\n")
	if e := st["tank"].Expand; e.State != "running" || e.Pct != 40 || e.Vdev != "raidz1-0" {
		t.Errorf("%+v", e)
	}
	st = parseZpoolStatus("  pool: tank\n state: ONLINE\nexpand: expanded raidz1-0 copied 3.00G in 00:01:00, on Wed Nov 25 10:01:00 2026\nconfig:\n\n\tNAME STATE READ WRITE CKSUM\n\ttank ONLINE 0 0 0\n" + raidzBody + "\nerrors: No known data errors\n")
	if e := st["tank"].Expand; e.State != "finished" {
		t.Errorf("%+v", e)
	}
}

func TestGrowReviewFixes(t *testing.T) {
	// A raidz pool whose raidz_expansion feature is disabled: refused at the plan.
	growHost(t, raidzBody, "0", "2.3.1")
	inner := hostOutput
	feature := "disabled"
	hostOutput = func(name string, args ...string) ([]byte, error) {
		j := strings.Join(args, " ")
		if name == "zpool" && strings.Contains(j, "feature@raidz_expansion") {
			return []byte(feature + "\n"), nil
		}
		if name == "zpool" && strings.Contains(j, "ashift") {
			return []byte("0\n"), nil
		}
		return inner(name, args...)
	}
	if _, fe := planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"raidz1-0","disk":"sdh"}`)); fe == nil || !strings.Contains(fe.Message, "upgrade") {
		t.Errorf("a pool without raidz_expansion was accepted: %v", fe)
	}
	feature = "enabled"
	if _, fe := planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"raidz1-0","disk":"sdh"}`)); fe != nil {
		t.Errorf("enabled feature refused: %s", fe.Message)
	}
	// A new group gets the pool's ashift (12 when unset).
	growHost(t, mirrorBody, "0", "2.2.2")
	inner = hostOutput
	hostOutput = func(name string, args ...string) ([]byte, error) {
		if name == "zpool" && strings.Contains(strings.Join(args, " "), "ashift") {
			return []byte("0\n"), nil
		}
		return inner(name, args...)
	}
	p, fe := planZfsPoolAdd([]byte(`{"pool":"tank","disks":["sdh","sdi"]}`))
	if fe != nil || commands(p) != "zpool add -o ashift=12 tank mirror /dev/disk/by-id/ata-WDC_H /dev/sdi" {
		t.Errorf("%v %v", commands(p), fe)
	}
	// A mirror mid-replacement: attach goes to a plain online disk.
	growHost(t, "\t  mirror-0 DEGRADED 0 0 0\n\t    replacing-0 DEGRADED 0 0 0\n\t      /dev/sdx1 UNAVAIL 0 0 0\n\t      /dev/sdy1 ONLINE 0 0 0\n\t    /dev/sdg1 ONLINE 0 0 0\n", "0", "2.2.2")
	p, fe = planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"mirror-0","disk":"sdh"}`))
	if fe != nil || commands(p) != "zpool attach tank /dev/sdg1 /dev/disk/by-id/ata-WDC_H" {
		t.Errorf("attach under a replacement: %v %v", commands(p), fe)
	}
	// Expand only online disks (an offline one stays offline), and special ones too.
	growHost(t, "\t  mirror-0 DEGRADED 0 0 0\n\t    /dev/sdf1 ONLINE 0 0 0\n\t    /dev/sdg1 OFFLINE 0 0 0\n\tspecial\n\t  /dev/nvme0n1p1 ONLINE 0 0 0\n\tlogs\n\t  /dev/nvme1n1p1 ONLINE 0 0 0\n", "5", "2.2.2")
	p, fe = planZfsPoolExpand([]byte(`{"pool":"tank"}`))
	if fe != nil || commands(p) != "zpool set autoexpand=on tank;zpool online -e tank /dev/sdf1;zpool online -e tank /dev/nvme0n1p1" {
		t.Errorf("expand: %v %v", commands(p), fe)
	}
}

func TestAttachRefusedWhileExpanding(t *testing.T) {
	growHost(t, raidzBody, "0", "2.3.1")
	inner := hostOutput
	hostOutput = func(name string, args ...string) ([]byte, error) {
		j := name + " " + strings.Join(args, " ")
		if strings.HasPrefix(j, "zpool status") {
			return []byte(strings.Replace(poolStatus("tank", raidzBody), "config:", "expand: expansion of raidz1-0 in progress since Wed Nov 25 10:00:00 2026\n\t1G / 3G copied, 33.00% done\nconfig:", 1)), nil
		}
		if strings.Contains(j, "feature@raidz_expansion") {
			return []byte("active\n"), nil
		}
		return inner(name, args...)
	}
	if _, fe := planZfsPoolAttach([]byte(`{"pool":"tank","vdev":"raidz1-0","disk":"sdh"}`)); fe == nil {
		t.Error("a second widening was accepted while one runs")
	}
}
