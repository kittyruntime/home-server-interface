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
