package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// stubDescribeFn makes describeVolume return a minimal description of any
// mount point, or err.
func stubDescribeFn(t *testing.T, err *fsError) *[]string {
	t.Helper()
	prev := describeVolumeFn
	t.Cleanup(func() { describeVolumeFn = prev })
	described := &[]string{}
	describeVolumeFn = func(mp string, now time.Time) (storageDescription, *fsError) {
		*described = append(*described, mp)
		if err != nil {
			return storageDescription{}, err
		}
		return storageDescription{Version: 1, Updated: now, Mount: descMount{Point: mp, Options: "defaults"}}, nil
	}
	return described
}

// hookPlan is a plan of one step that succeeds or fails.
func hookPlan(fail bool) *opPlan {
	return &opPlan{Op: "test", Observed: map[string]string{}, Steps: []planStep{{Kind: "run", Target: "x", Summary: "step",
		run: func() (string, error) {
			if fail {
				return "", errors.New("boom")
			}
			return "", nil
		}}}}
}

func runHooked(t *testing.T, p *opPlan) *planApply {
	t.Helper()
	prev := planBuilders["test"]
	planBuilders["test"] = func(json.RawMessage) (*opPlan, *fsError) { return p, nil }
	t.Cleanup(func() {
		if prev == nil {
			delete(planBuilders, "test")
		} else {
			planBuilders["test"] = prev
		}
	})
	out, fe := applyPlan("test", []byte(`{}`), p.fingerprint([]byte(`{}`)))
	if fe != nil {
		t.Fatal(fe)
	}
	return out
}

func TestDescribeHookOnSuccess(t *testing.T) {
	stubDescriptionsDir(t)
	stubDescribeFn(t, nil)
	p := hookPlan(false)
	p.Describe = []string{"/srv/data"}
	runHooked(t, p)
	if d, _ := loadDescriptions(); d["/srv/data"].Mount.Point != "/srv/data" {
		t.Fatalf("described: %+v", d)
	}
}

func TestDescribeHookSkippedOnFailure(t *testing.T) {
	stubDescriptionsDir(t)
	described := stubDescribeFn(t, nil)
	p := hookPlan(true)
	p.Describe = []string{"/srv/data"}
	runHooked(t, p)
	if d, _ := loadDescriptions(); len(d) != 0 || len(*described) != 0 {
		t.Fatalf("a failed plan describes nothing: %+v", d)
	}
}

func TestDescribeHookOnlyTouchedVolume(t *testing.T) {
	stubDescriptionsDir(t)
	other := storageDescription{Version: 1, Mount: descMount{Point: "/srv/other", Options: "edited,by,hand"}}
	path, _ := saveDescription(other)
	before, _ := os.ReadFile(path)
	stubDescribeFn(t, nil)
	p := hookPlan(false)
	p.Describe = []string{"/srv/data"}
	runHooked(t, p)
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("another volume's description was rewritten")
	}
}

func TestForgetHook(t *testing.T) {
	stubDescriptionsDir(t)
	_, _ = saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/data"}})
	p := hookPlan(false)
	p.Forget = []string{"/srv/data"}
	runHooked(t, p)
	if d, _ := loadDescriptions(); len(d) != 0 {
		t.Fatalf("forgotten: %+v", d)
	}
}

func TestDescribeArrayHook(t *testing.T) {
	stubDescriptionsDir(t)
	_, _ = saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/a"}, Array: &descArray{UUID: "U1"}})
	_, _ = saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/b"}, Array: &descArray{UUID: "U2"}})
	described := stubDescribeFn(t, nil)
	p := hookPlan(false)
	p.DescribeArrayUUID = "U1"
	runHooked(t, p)
	if strings.Join(*described, ",") != "/srv/a" {
		t.Fatalf("only the volumes on that array: %v", *described)
	}
}

func TestDescribeWriteFailureIsWarning(t *testing.T) {
	stubDescriptionsDir(t)
	stubDescribeFn(t, &fsError{Code: "ENOTMOUNTED", Message: "/srv/data is not mounted"})
	p := hookPlan(false)
	p.Describe = []string{"/srv/data"}
	out := runHooked(t, p)
	if !out.OK || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "not mounted") {
		t.Fatalf("warning, plan ok: %+v", out)
	}
}

func TestPlansSetHooks(t *testing.T) {
	t.Run("volume.create", func(t *testing.T) {
		stubVolumeHost(t)
		p, fe := build(t, planVolumeCreate, mirrorReq)
		if fe != nil || strings.Join(p.Describe, ",") != "/srv/data" {
			t.Fatalf("%+v %+v", p, fe)
		}
	})
	t.Run("mount", func(t *testing.T) {
		stubMountHost(t)
		stubConfigFiles(t, "", "")
		p, fe := build(t, planMount, `{"device":"sdb1","mountpoint":"/mnt/data","persist":true}`)
		if fe != nil || strings.Join(p.Describe, ",") != "/mnt/data" {
			t.Fatalf("persisted: %+v %+v", p, fe)
		}
		p, fe = build(t, planMount, `{"device":"sdb1","mountpoint":"/mnt/data"}`)
		if fe != nil || len(p.Describe) != 0 {
			t.Fatalf("not persisted: %+v %+v", p, fe)
		}
	})
	t.Run("umount", func(t *testing.T) {
		stubMountHost(t)
		stubConfigFiles(t, "", "")
		p, _ := build(t, planUmount, `{"mountpoint":"/mnt/data","removeFromFstab":true}`)
		if strings.Join(p.Forget, ",") != "/mnt/data" {
			t.Fatalf("forget: %+v", p.Forget)
		}
		p, _ = build(t, planUmount, `{"mountpoint":"/mnt/data"}`)
		if len(p.Forget) != 0 {
			t.Fatalf("kept in fstab: %+v", p.Forget)
		}
	})
	t.Run("volume.remove", func(t *testing.T) {
		stubRemoveHost(t)
		p, fe := planVolumeRemove([]byte(removeReq))
		if fe != nil || strings.Join(p.Forget, ",") != "/srv/data" {
			t.Fatalf("%+v %+v", p, fe)
		}
	})
	t.Run("volume.expand", func(t *testing.T) {
		stubExpandHost(t)
		hostVgFree = func(string) int64 { return 32e9 }
		p, fe := expand(t, "vgFree", "")
		if fe != nil || strings.Join(p.Redescribe, ",") != "/srv/data" {
			t.Fatalf("%+v %+v", p, fe)
		}
	})
	t.Run("raid.add", func(t *testing.T) {
		stubRaidManageHost(t)
		p, fe := planRaidAdd([]byte(`{"name":"md0","device":"sdd"}`))
		if fe != nil || p.DescribeArrayUUID == "" {
			t.Fatalf("%+v %+v", p, fe)
		}
	})
}

func TestFinisherDescribes(t *testing.T) {
	stubDescriptionsDir(t)
	stubExpansions(t, reshaping)
	hostSyncAction = func(string) string { return "idle" }
	described := stubDescribeFn(t, nil)
	finishExpansions(time.Now())
	if strings.Join(*described, ",") != "/srv/data" {
		t.Fatalf("described after the finish: %v", *described)
	}
}

func TestBackfillSkipsUnmounted(t *testing.T) {
	stubDescriptionsDir(t)
	stubConfigFiles(t, "# HSI-managed mount: /srv/a\nUUID=a\t/srv/a\text4\tdefaults\t0\t2\n# HSI-managed mount: /srv/b\nUUID=b\t/srv/b\text4\tdefaults\t0\t2\n", "")
	pm := hostProcMounts
	t.Cleanup(func() { hostProcMounts = pm })
	hostProcMounts = func() string { return "/dev/sdb1 /srv/a ext4 rw 0 0\n" }
	described := stubDescribeFn(t, nil)
	backfillDescriptions(time.Now())
	if strings.Join(*described, ",") != "/srv/a" {
		t.Fatalf("only the mounted one: %v", *described)
	}
	d, _ := loadDescriptions()
	if _, ok := d["/srv/a"]; !ok || len(d) != 1 {
		t.Fatalf("written: %+v", d)
	}
}
