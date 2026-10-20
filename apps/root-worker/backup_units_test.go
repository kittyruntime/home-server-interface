package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func useUnits(t *testing.T) *[]string {
	t.Helper()
	root := useBackupDirs(t)
	t.Setenv("HSI_SYSTEMD_DIR", filepath.Join(root, "systemd"))
	_ = os.MkdirAll(filepath.Join(root, "systemd"), 0o755)
	calls := &[]string{}
	prev := systemctl
	systemctl = func(args ...string) ([]byte, error) {
		*calls = append(*calls, strings.Join(args, " "))
		return nil, nil
	}
	prevArgv := runArgv
	runArgv = func(argv []string) ([]byte, error) { *calls = append(*calls, strings.Join(argv, " ")); return nil, nil }
	t.Cleanup(func() { systemctl = prev; runArgv = prevArgv })
	return calls
}

func TestPlanTimerUnit(t *testing.T) {
	p := sampleConfig().Plans[0]
	u := planTimerUnit(p)
	for _, want := range []string{"OnCalendar=*-*-* 02:30:00", "Persistent=true", "Unit=hsi-backup@" + planA + ".service", "WantedBy=timers.target"} {
		if !strings.Contains(u, want) {
			t.Errorf("missing %q in\n%s", want, u)
		}
	}
	p.Enabled = false
	if planTimerUnit(p) != "" {
		t.Error("disabled plan has a timer")
	}
	p.Enabled, p.Schedule.Every = true, "manual"
	if planTimerUnit(p) != "" {
		t.Error("manual plan has a timer")
	}
	p.Name = "evil\n[Service]"
	p.Schedule.Every = "daily"
	if strings.Contains(planTimerUnit(p), "\n[Service]") {
		t.Error("newline in description")
	}
}

func TestCheckTimerUnit(t *testing.T) {
	r := sampleConfig().Repositories[0]
	u := checkTimerUnit(r)
	for _, want := range []string{"Description=HSI backup repository check USB", "Unit=hsi-backup-check@" + repoA + ".service"} {
		if !strings.Contains(u, want) {
			t.Errorf("missing %q in\n%s", want, u)
		}
	}
	r.Check.Every = "off"
	if checkTimerUnit(r) != "" {
		t.Error("off check has a timer")
	}
}
