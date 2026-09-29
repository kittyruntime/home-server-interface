package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPreviewAndApply(t *testing.T) {
	stubMountHost(t)
	conf := "# HSI-managed mount: /mnt/data\nUUID=uuid-sdb1\t/mnt/data\text4\tdefaults\t0\t2\n"
	fstab, _ := stubConfigFiles(t, conf, "")
	input := json.RawMessage(`{"mountpoint":"/mnt/data","removeFromFstab":true}`)

	if _, fe := previewPlan("nope", input); fe == nil || fe.Code != "ERR" {
		t.Fatalf("unknown op: %+v", fe)
	}
	prev, fe := previewPlan("umount", input) // runArgv fails the test if anything runs
	if fe != nil || len(prev.Steps) != 3 || prev.Fingerprint == "" {
		t.Fatalf("preview: %+v %+v", prev, fe)
	}

	var ran [][]string
	runArgv = func(argv []string) ([]byte, error) { ran = append(ran, argv); return nil, nil }
	res, fe := applyPlan("umount", input, prev.Fingerprint)
	if fe != nil || !res.OK || len(ran) != 2 {
		t.Fatalf("apply: %+v %+v ran=%v", res, fe, ran)
	}

	// Server changed since the preview: refused, nothing runs.
	prev, _ = previewPlan("umount", input)
	if err := os.WriteFile(fstab, []byte(conf+"UUID=x /mnt/other ext4 defaults 0 2\n"), 0644); err != nil {
		t.Fatal(err)
	}
	ran = nil
	if _, fe := applyPlan("umount", input, prev.Fingerprint); fe == nil || fe.Code != "ESTALE" || len(ran) != 0 {
		t.Fatalf("stale apply: %+v ran=%v", fe, ran)
	}
}

func TestApplyReportsFailedStep(t *testing.T) {
	stubMountHost(t)
	stubConfigFiles(t, "", "")
	input := json.RawMessage(`{"mountpoint":"/mnt/data"}`)
	prev, _ := previewPlan("umount", input)
	runArgv = func(argv []string) ([]byte, error) { return []byte("target is busy"), os.ErrPermission }
	res, fe := applyPlan("umount", input, prev.Fingerprint)
	if fe != nil || res.OK || res.Error == "" || res.Results[0].Status != "failed" {
		t.Fatalf("failed apply: %+v %+v", res, fe)
	}
}
