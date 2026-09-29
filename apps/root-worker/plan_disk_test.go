package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// stubHost replaces every host read with neutral fixtures for the test.
func stubHost(t *testing.T) {
	t.Helper()
	saved := []func(){}
	save := func(restore func()) { saved = append(saved, restore) }
	pm, sd, mo, cl, lp, de, sg, md, lv, ra := hostProcMounts, hostSystemDevs, hostMemberOf, hostClaimable, hostLookPath, hostDescribe, hostSignatures, hostMdDetail, hostLvs, runArgv
	save(func() {
		hostProcMounts, hostSystemDevs, hostMemberOf, hostClaimable, hostLookPath, hostDescribe, hostSignatures, hostMdDetail, hostLvs, runArgv = pm, sd, mo, cl, lp, de, sg, md, lv, ra
	})
	hostProcMounts = func() string { return "/dev/sda2 / ext4 rw 0 0\n" }
	hostSystemDevs = func() map[string]bool { return map[string]bool{"sda": true, "sda2": true} }
	hostMemberOf = func(string) (bool, string) { return false, "" }
	hostClaimable = func(string) *fsError { return nil }
	hostLookPath = func(string) bool { return true }
	hostDescribe = func(dev string) *deviceInfo {
		return &deviceInfo{Path: dev, Model: "WDC WD40EFRX", Serial: "WD-" + strings.TrimPrefix(dev, "/dev/"), Size: 4000787030016, Contents: "no filesystem"}
	}
	hostSignatures = func(dev string) string { return "sig:" + dev }
	hostMdDetail = func(string) (string, error) { return "", nil }
	hostLvs = func() []lvmLV { return nil }
	// Building a plan must never execute anything.
	runArgv = func(argv []string) ([]byte, error) {
		t.Fatalf("command executed while building a plan: %v", argv)
		return nil, nil
	}
	t.Cleanup(func() {
		for _, r := range saved {
			r()
		}
	})
}

func build(t *testing.T, f func(json.RawMessage) (*opPlan, *fsError), input string) (*opPlan, *fsError) {
	t.Helper()
	return f(json.RawMessage(input))
}

func argvs(p *opPlan) [][]string {
	var out [][]string
	for _, s := range p.Steps {
		if s.Kind == "run" {
			out = append(out, s.Command)
		}
	}
	return out
}

// assertParity executes the plan with a recording runner and checks it ran
// exactly the previewed commands, in order.
func assertParity(t *testing.T, p *opPlan) {
	t.Helper()
	var ran [][]string
	runArgv = func(argv []string) ([]byte, error) { ran = append(ran, argv); return nil, nil }
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("plan failed with a successful runner")
	}
	if !reflect.DeepEqual(ran, argvs(p)) {
		t.Fatalf("executed %v, previewed %v", ran, argvs(p))
	}
}

func wantErr(t *testing.T, fe *fsError, code string) {
	t.Helper()
	if fe == nil || fe.Code != code {
		t.Fatalf("want %s, got %+v", code, fe)
	}
}

func TestPlanFormat(t *testing.T) {
	stubHost(t)
	p, fe := build(t, planFormat, `{"device":"sdb1","fstype":"ext4","label":"media"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"mkfs.ext4", "-F", "-L", "media", "/dev/sdb1"}, {"partprobe", "/dev/sdb1"}, {"udevadm", "settle"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("got %v", argvs(p))
	}
	if !p.Steps[0].Destructive || p.Steps[0].Device == nil || p.Steps[0].Device.Serial != "WD-sdb1" {
		t.Fatalf("mkfs step must be destructive and name the device: %+v", p.Steps[0])
	}
	if p.Steps[1].OnFailure != "ignore" || p.Steps[2].OnFailure != "ignore" {
		t.Fatal("partprobe/settle are best effort")
	}
	if p.Observed["target:signatures"] != "sig:/dev/sdb1" {
		t.Fatalf("observed %v", p.Observed)
	}
	assertParity(t, p)
}

func TestPlanFormatRefusals(t *testing.T) {
	stubHost(t)
	_, fe := build(t, planFormat, `{"device":"sda2","fstype":"ext4"}`)
	wantErr(t, fe, "ESYS")
	hostProcMounts = func() string { return "/dev/sdb1 /mnt/x ext4 rw 0 0\n" }
	_, fe = build(t, planFormat, `{"device":"sdb1","fstype":"ext4"}`)
	wantErr(t, fe, "EMNT")
	hostProcMounts = func() string { return "" }
	hostMemberOf = func(string) (bool, string) { return true, "sdb1 is a member of md0" }
	_, fe = build(t, planFormat, `{"device":"sdb1","fstype":"ext4"}`)
	wantErr(t, fe, "EMEMBER")
	hostMemberOf = func(string) (bool, string) { return false, "" }
	_, fe = build(t, planFormat, `{"device":"sdb1","fstype":"ntfs"}`)
	wantErr(t, fe, "ERR")
}

func TestPlanPartitions(t *testing.T) {
	stubHost(t)
	p, fe := build(t, planPartInit, `{"device":"sdb"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"parted", "-s", "/dev/sdb", "mklabel", "gpt"}) || !p.Steps[0].Destructive {
		t.Fatalf("part.init: %v %v", fe, argvs(p))
	}
	assertParity(t, p)

	stubHost(t)
	p, fe = build(t, planPartCreate, `{"device":"sdb","startPct":0,"endPct":50}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"parted", "-s", "/dev/sdb", "mkpart", "primary", "0%", "50%"}) {
		t.Fatalf("part.create: %v %v", fe, argvs(p))
	}
	_, fe = build(t, planPartCreate, `{"device":"sdb","startPct":60,"endPct":50}`)
	wantErr(t, fe, "ERR")

	stubHost(t)
	p, fe = build(t, planPartDelete, `{"device":"nvme0n1","partNum":"2"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"parted", "-s", "/dev/nvme0n1", "rm", "2"}) || p.Steps[0].Device.Path != "/dev/nvme0n1p2" {
		t.Fatalf("part.delete: %v %v", fe, p)
	}
	hostProcMounts = func() string { return "/dev/nvme0n1p2 /mnt/x ext4 rw 0 0\n" }
	_, fe = build(t, planPartDelete, `{"device":"nvme0n1","partNum":"2"}`)
	wantErr(t, fe, "EMNT")
}

func TestPlanLvm(t *testing.T) {
	stubHost(t)
	p, fe := build(t, planPvCreate, `{"devices":["sdb","sdc"]}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"pvcreate", "-f", "/dev/sdb", "/dev/sdc"}) || !p.Steps[0].Destructive {
		t.Fatalf("pv.create: %v %v", fe, argvs(p))
	}
	assertParity(t, p)

	stubHost(t)
	p, fe = build(t, planVgCreate, `{"name":"data","devices":["sdb","sdc"]}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"vgcreate", "data", "/dev/sdb", "/dev/sdc"}) {
		t.Fatalf("vg.create: %v %v", fe, argvs(p))
	}

	p, fe = build(t, planLvCreate, `{"vgName":"data","lvName":"media","sizeBytes":0}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"lvcreate", "-l", "100%FREE", "-n", "media", "data"}) {
		t.Fatalf("lv.create: %v %v", fe, argvs(p))
	}
	p, _ = build(t, planLvCreate, `{"vgName":"data","lvName":"media","sizeBytes":1024}`)
	if !reflect.DeepEqual(argvs(p)[0], []string{"lvcreate", "-L", "1024B", "-n", "media", "data"}) {
		t.Fatalf("lv.create sized: %v", argvs(p))
	}

	p, fe = build(t, planLvRemove, `{"vgName":"data","lvName":"media"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"lvremove", "-f", "/dev/data/media"}) || !p.Steps[0].Destructive {
		t.Fatalf("lv.remove: %v %v", fe, argvs(p))
	}
	hostProcMounts = func() string { return "/dev/mapper/data-media /mnt/m ext4 rw 0 0\n" }
	_, fe = build(t, planLvRemove, `{"vgName":"data","lvName":"media"}`)
	wantErr(t, fe, "EMNT")

	hostLvs = func() []lvmLV { return []lvmLV{{Name: "media", VGName: "data", Path: "/dev/data/media"}} }
	_, fe = build(t, planVgRemove, `{"vgName":"data"}`)
	wantErr(t, fe, "EMNT")
	hostProcMounts = func() string { return "" }
	p, fe = build(t, planVgRemove, `{"vgName":"data"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p)[0], []string{"vgremove", "-f", "data"}) || !p.Steps[0].Destructive {
		t.Fatalf("vg.remove: %v %v", fe, argvs(p))
	}
}

func TestPlanPvCreateNamesEveryDevice(t *testing.T) {
	stubHost(t)
	p, _ := build(t, planPvCreate, `{"devices":["sdb","sdc"]}`)
	if len(p.Steps[0].Devices) != 2 {
		t.Fatalf("devices %+v", p.Steps[0].Devices)
	}
}
