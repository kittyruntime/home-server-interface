package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestClassifySelfTestStart(t *testing.T) {
	cases := []struct {
		name, out  string
		err        error
		wantStatus string
	}{
		{"started", "=== START OF OFFLINE IMMEDIATE AND SELF-TEST SECTION ===\nTesting has begun.\n", nil, "started"},
		{"nvme started", "Self-test has begun\n", nil, "started"},
		{"standby", "Device is in STANDBY mode, exit(2)\n", errors.New("exit status 2"), "skipped"},
		{"already running", "Can't start self-test without aborting current test (90% remaining),\n", errors.New("exit status 4"), "skipped"},
		{"virtio", "/dev/vdb: Unable to detect device type\n", errors.New("exit status 1"), "skipped"},
		{"other failure", "Read Device Identity failed: I/O error\n", errors.New("exit status 2"), "error"},
		// QEMU's emulated SCSI disks answer the test command with an error.
		{"scsi without self-tests", "smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)\nCopyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org\n\nShort offline self test failed [unsupported scsi opcode]\n", errors.New("exit status 4"), "skipped"},
	}
	for _, c := range cases {
		if status, _ := classifySelfTestStart(c.out, c.err); status != c.wantStatus {
			t.Errorf("%s: status = %q, want %q", c.name, status, c.wantStatus)
		}
	}
}

// An error message keeps what went wrong, not smartctl's banner.
func TestClassifySelfTestStartDropsTheBanner(t *testing.T) {
	out := "smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)\nCopyright (C) 2002-23, Bruce Allen, Christian Franke, www.smartmontools.org\n\nRead Device Identity failed: I/O error\n"
	_, msg := classifySelfTestStart(out, errors.New("exit status 2"))
	if strings.Contains(msg, "Copyright") || strings.Contains(msg, "smartctl 7.4") || !strings.Contains(msg, "I/O error") {
		t.Fatalf("message: %q", msg)
	}
}

// A run where nothing could start (an array rebuilding) does not count: the
// hourly timer tries again, and the last real results stay shown.
func TestMaintenancePostponedRunIsRetried(t *testing.T) {
	dir := t.TempDir()
	pc, ps, pl, pr := maintenanceConfigPath, maintenanceStatePath, maintenanceLockPath, runMaintenanceTask
	t.Cleanup(func() {
		maintenanceConfigPath, maintenanceStatePath, maintenanceLockPath, runMaintenanceTask = pc, ps, pl, pr
	})
	maintenanceConfigPath, maintenanceStatePath, maintenanceLockPath = dir+"/cfg.json", dir+"/state.json", dir+"/lock"

	runMaintenanceTask = func(string) []taskResult { return []taskResult{{Device: "md2", Status: "started"}} }
	first := time.Date(2026, 10, 4, 3, 0, 0, 0, time.UTC)
	if err := runMaintenance(first, "raidCheck"); err != nil {
		t.Fatal(err)
	}
	runMaintenanceTask = func(string) []taskResult {
		return []taskResult{{Device: "md2", Status: "skipped", Message: "an array is syncing (recovery)"}}
	}
	if err := runMaintenance(first.Add(24*time.Hour), "raidCheck"); err != nil {
		t.Fatal(err)
	}
	st := loadMaintenanceState()["raidCheck"]
	if st.LastRun == nil || !st.LastRun.Equal(first) || st.Results[0].Status != "started" {
		t.Fatalf("the last real run stays: %+v", st)
	}
	if st.Postponed == nil || !strings.Contains(st.Postponed.Reason, "syncing") {
		t.Fatalf("the postponement is shown: %+v", st.Postponed)
	}
}
