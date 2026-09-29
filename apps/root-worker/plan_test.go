package main

import (
	"encoding/json"
	"errors"
	"testing"
)

func testPlan() *opPlan {
	return &opPlan{
		Op: "format",
		Steps: []planStep{
			{Kind: "run", Target: "/dev/sdz1", Summary: "Create ext4", Command: []string{"mkfs.ext4", "-F", "/dev/sdz1"}, Destructive: true},
			{Kind: "update", Target: "/etc/mdadm/mdadm.conf", Summary: "Add ARRAY", Deferred: true, Diff: "computed later"},
		},
		Observed: map[string]string{"b": "2", "a": "1"},
	}
}

func TestFingerprintStableAndSensitive(t *testing.T) {
	in := json.RawMessage(`{"device":"sdz1","fstype":"ext4"}`)
	in2 := json.RawMessage(`{"fstype":"ext4","device":"sdz1"}`)
	base := testPlan().fingerprint(in)
	if base != testPlan().fingerprint(in2) {
		t.Fatal("input key order must not matter")
	}
	p := testPlan()
	p.Steps[1].Diff = "something else"
	p.Steps[0].run = func() (string, error) { return "", nil }
	if p.fingerprint(in) != base {
		t.Fatal("deferred content and run functions must not change the fingerprint")
	}
	for name, mutate := range map[string]func(*opPlan){
		"summary":  func(p *opPlan) { p.Steps[0].Summary = "x" },
		"command":  func(p *opPlan) { p.Steps[0].Command = []string{"mkfs.xfs"} },
		"observed": func(p *opPlan) { p.Observed["a"] = "changed" },
	} {
		q := testPlan()
		mutate(q)
		if q.fingerprint(in) == base {
			t.Errorf("%s change must change the fingerprint", name)
		}
	}
	if testPlan().fingerprint(json.RawMessage(`{"device":"sdy1","fstype":"ext4"}`)) == base {
		t.Error("input change must change the fingerprint")
	}
}

func step(policy string, err error, detail string) planStep {
	return planStep{Kind: "run", Summary: "s", OnFailure: policy, run: func() (string, error) { return detail, err }}
}

func TestExecutePolicies(t *testing.T) {
	boom := errors.New("boom")
	p := &opPlan{Steps: []planStep{step("", nil, ""), step("warn", boom, ""), step("ignore", boom, ""), step("", boom, ""), step("", nil, "")}}
	res, ok, warnings := p.execute()
	if ok {
		t.Fatal("a stop failure must fail the plan")
	}
	got := []string{}
	for _, r := range res {
		got = append(got, r.Status)
	}
	want := []string{"done", "warning", "skipped", "failed", "not-run"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("statuses %v, want %v", got, want)
		}
	}
	if len(warnings) != 1 || res[3].Error != "boom" {
		t.Fatalf("warnings %v, failed error %q", warnings, res[3].Error)
	}
}

func TestExecuteDeferredDetail(t *testing.T) {
	p := &opPlan{Steps: []planStep{{Kind: "update", Deferred: true, run: func() (string, error) { return "+ARRAY /dev/md0", nil }}}}
	res, ok, _ := p.execute()
	if !ok || res[0].Detail != "+ARRAY /dev/md0" {
		t.Fatalf("deferred detail not reported: %+v", res)
	}
}

func TestIsMountedSource(t *testing.T) {
	mounts := "/dev/sda2 / ext4 rw 0 0\n/dev/sdb1 /mnt/data ext4 rw 0 0\n"
	if !isMountedSource(mounts, "/dev/sdb1") || isMountedSource(mounts, "/dev/sdb2") || !isMountedSource(mounts, "/dev/x", "/dev/sda2") {
		t.Fatal("isMountedSource mismatch")
	}
}

func TestParseLsblkDevice(t *testing.T) {
	js := `{"blockdevices":[{"path":"/dev/sdb","model":"WDC WD40EFRX","serial":"WD-WX12","size":4000787030016,"fstype":null,"label":null,
	  "children":[{"path":"/dev/sdb1","model":null,"serial":null,"size":4000785964544,"fstype":"ext4","label":"media"}]}]}`
	d := parseLsblkDevice([]byte(js))
	if d.Path != "/dev/sdb" || d.Model != "WDC WD40EFRX" || d.Serial != "WD-WX12" || d.Size != 4000787030016 {
		t.Fatalf("got %+v", d)
	}
	if d.Contents != `1 partition: ext4 "media"` {
		t.Fatalf("contents %q", d.Contents)
	}
	part := parseLsblkDevice([]byte(`{"blockdevices":[{"path":"/dev/sdb1","model":null,"serial":null,"size":10,"fstype":"linux_raid_member","label":null}]}`))
	if part.Contents != "RAID member" {
		t.Fatalf("contents %q", part.Contents)
	}
	blank := parseLsblkDevice([]byte(`{"blockdevices":[{"path":"/dev/sdc","size":10}]}`))
	if blank.Contents != "no filesystem" {
		t.Fatalf("contents %q", blank.Contents)
	}
}
