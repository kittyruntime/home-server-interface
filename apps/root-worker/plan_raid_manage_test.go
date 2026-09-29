package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const md0Detail = "/dev/md0:\n  Resync Status : 40% complete\n         Events : 12\n           UUID : aa:bb\n    Number   Major   Minor   RaidDevice State\n" +
	"       0       8       16        0      active sync   /dev/sdb\n       1       8       32        1      active sync   /dev/sdc\n"

func stubRaidManageHost(t *testing.T) {
	stubMountHost(t)
	ps, pa := hostDeviceSize, hostActiveArrays
	t.Cleanup(func() { hostDeviceSize, hostActiveArrays = ps, pa })
	hostMdDetail = func(string) (string, error) { return md0Detail, nil }
	hostDeviceSize = func(string) (int64, error) { return 1000, nil }
	hostActiveArrays = func() map[string]bool { return map[string]bool{} }
}

func TestPlanRaidFailAndRemove(t *testing.T) {
	stubRaidManageHost(t)
	p, fe := build(t, planRaidFail, `{"name":"md0","device":"sdb"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p), [][]string{{"mdadm", "--manage", "/dev/md0", "--fail", "/dev/sdb"}}) {
		t.Fatalf("fail: %v %v", fe, argvs(p))
	}
	assertParity(t, p)

	stubRaidManageHost(t)
	_, fe = build(t, planRaidFail, `{"name":"md0","device":"sdd"}`)
	wantErr(t, fe, "ERR") // not a member
	hostSystemDevs = func() map[string]bool { return map[string]bool{"md0": true} }
	_, fe = build(t, planRaidRemove, `{"name":"md0","device":"sdb"}`)
	wantErr(t, fe, "ESYS")

	stubRaidManageHost(t)
	hostExists = func(string) bool { return false } // disk unplugged
	p, fe = build(t, planRaidRemove, `{"name":"md0","device":"sdc"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"mdadm", "--manage", "/dev/md0", "--remove", "detached"}) {
		t.Fatalf("remove detached: %v %v", fe, argvs(p))
	}
}

func TestPlanRaidAdd(t *testing.T) {
	stubRaidManageHost(t)
	p, fe := build(t, planRaidAdd, `{"name":"md0","device":"sdd"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"mdadm", "--manage", "/dev/md0", "--add", "/dev/sdd"}) {
		t.Fatalf("add: %v %v", fe, argvs(p))
	}
	if !p.Steps[0].Destructive || p.Steps[0].Device == nil || p.Steps[0].Device.Path != "/dev/sdd" {
		t.Fatalf("add must name the erased disk: %+v", p.Steps[0])
	}
	assertParity(t, p)

	stubRaidManageHost(t)
	_, fe = build(t, planRaidAdd, `{"name":"md0","device":"sdb"}`)
	wantErr(t, fe, "ERR") // already a member
	hostDeviceSize = func(dev string) (int64, error) {
		if dev == "/dev/sdd" {
			return 10, nil
		}
		return 1000, nil
	}
	_, fe = build(t, planRaidAdd, `{"name":"md0","device":"sdd"}`)
	if fe == nil || !strings.Contains(fe.Message, "too small") {
		t.Fatalf("too small: %+v", fe)
	}
	hostDeviceSize = func(string) (int64, error) { return 1000, nil }
	hostClaimable = func(string) *fsError { return &fsError{Code: "EBUSY", Message: "holds data"} }
	_, fe = build(t, planRaidAdd, `{"name":"md0","device":"sdd"}`)
	wantErr(t, fe, "EBUSY")
}

func TestPlanRaidManageStableDuringResync(t *testing.T) {
	stubRaidManageHost(t)
	in := json.RawMessage(`{"name":"md0","device":"sdd"}`)
	p1, _ := planRaidAdd(in)
	hostMdDetail = func(string) (string, error) {
		return strings.Replace(strings.Replace(md0Detail, "40%", "41%", 1), "Events : 12", "Events : 13", 1), nil
	}
	p2, _ := planRaidAdd(in)
	if p1.fingerprint(in) != p2.fingerprint(in) {
		t.Fatal("resync progress must not make the plan stale")
	}
}

func TestPlanImport(t *testing.T) {
	stubRaidManageHost(t)
	stubConfigFiles(t, "", "")
	p, fe := build(t, planImportAssemble, `{"uuid":"aa:bb:cc:dd","name":"md1","allowDegraded":true}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"mdadm", "--assemble", "/dev/md1", "--uuid=aa:bb:cc:dd", "--scan", "--run"}) {
		t.Fatalf("assemble: %v %v", fe, argvs(p))
	}
	if !strings.Contains(p.Steps[0].Summary, "missing") || !p.Steps[1].Deferred || p.Reply["device"] != "/dev/md1" {
		t.Fatalf("assemble steps: %+v", p.Steps)
	}
	hostActiveArrays = func() map[string]bool { return map[string]bool{"aa:bb:cc:dd": true} }
	_, fe = build(t, planImportAssemble, `{"uuid":"aa:bb:cc:dd","name":"md1"}`)
	wantErr(t, fe, "EEXIST")

	p, fe = build(t, planImportActivate, `{"name":"vg.old"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"vgchange", "-ay", "vg.old"}) {
		t.Fatalf("activate: %v %v", fe, argvs(p))
	}
	_, fe = build(t, planImportActivate, `{"name":"bad name"}`)
	wantErr(t, fe, "ERR")
}

func TestPlanRaidFailNamesTheDisk(t *testing.T) {
	stubRaidManageHost(t)
	p, fe := build(t, planRaidFail, `{"name":"md0","device":"sdb"}`)
	if fe != nil || p.Steps[0].Device == nil || p.Steps[0].Device.Serial != "WD-sdb" {
		t.Fatalf("the disk to fail must be named: %v %+v", fe, p.Steps[0])
	}
}

func TestPlanRaidFailRefusedWithoutRedundancy(t *testing.T) {
	stubRaidManageHost(t)
	degraded := "/dev/md0:\n     Raid Level : raid5\n   Raid Devices : 3\n Active Devices : 2\n           UUID : aa:bb\n" +
		"    Number   Major   Minor   RaidDevice State\n       0       8       16        0      active sync   /dev/sdb\n" +
		"       1       8       32        1      active sync   /dev/sdc\n       -       0        0        2      removed\n"
	hostMdDetail = func(string) (string, error) { return degraded, nil }
	_, fe := build(t, planRaidFail, `{"name":"md0","device":"sdb"}`)
	if fe == nil || !strings.Contains(fe.Message, "no redundancy left") {
		t.Fatalf("failing a member of an array without redundancy must be refused: %+v", fe)
	}
	healthy := "/dev/md0:\n     Raid Level : raid1\n   Raid Devices : 2\n Active Devices : 2\n           UUID : aa:bb\n" +
		"    Number   Major   Minor   RaidDevice State\n       0       8       16        0      active sync   /dev/sdb\n       1       8       32        1      active sync   /dev/sdc\n"
	hostMdDetail = func(string) (string, error) { return healthy, nil }
	if _, fe := build(t, planRaidFail, `{"name":"md0","device":"sdb"}`); fe != nil {
		t.Fatalf("healthy RAID1 member can be failed: %+v", fe)
	}
}

func TestPlanRaidRemoveVanishedMember(t *testing.T) {
	stubRaidManageHost(t)
	// The disk is gone: mdadm lists its row without a /dev path.
	gone := "/dev/md0:\n           UUID : aa:bb\n    Number   Major   Minor   RaidDevice State\n       0       8       16        0      active sync   /dev/sdb\n" +
		"       1       8       32        1      faulty\n"
	hostMdDetail = func(string) (string, error) { return gone, nil }
	hostExists = func(p string) bool { return p == "/sys/block/md0/md/dev-sdc" }
	p, fe := build(t, planRaidRemove, `{"name":"md0","device":"sdc"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"mdadm", "--manage", "/dev/md0", "--remove", "detached"}) {
		t.Fatalf("vanished member: %v %v", fe, p)
	}
	assertParity(t, p)
}
