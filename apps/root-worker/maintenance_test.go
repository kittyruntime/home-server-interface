package main

import (
	"errors"
	"testing"
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
	}
	for _, c := range cases {
		if status, _ := classifySelfTestStart(c.out, c.err); status != c.wantStatus {
			t.Errorf("%s: status = %q, want %q", c.name, status, c.wantStatus)
		}
	}
}
