package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func unitPrefix() string {
	return envOr("HSI_UNIT_PREFIX", "hsi")
}

func systemdDir() string {
	return envOr("HSI_SYSTEMD_DIR", "/etc/systemd/system")
}

func planTimerName(id string) string {
	return unitPrefix() + "-backup@" + id + ".timer"
}

func checkTimerName(id string) string {
	return unitPrefix() + "-backup-check@" + id + ".timer"
}

// unitText keeps a user supplied name on one line of the unit file, and keeps a "%"
// literal: systemd reads "%n" and the like as specifiers.
func unitText(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ", "%", "%%").Replace(s)
}

func timerUnit(description, calendar, service string) string {
	return "[Unit]\nDescription=" + unitText(description) + "\n\n" +
		"[Timer]\nOnCalendar=" + calendar + "\nPersistent=true\nUnit=" + service + "\n\n" +
		"[Install]\nWantedBy=timers.target\n"
}

// planTimerUnit is "" when the plan has no timer (manual or disabled).
func planTimerUnit(p backupPlanCfg) string {
	cal := onCalendar(p.Schedule)
	if !p.Enabled || cal == "" {
		return ""
	}
	return timerUnit("HSI backup plan "+p.Name, cal, unitPrefix()+"-backup@"+p.ID+".service")
}

// checkTimerUnit is "" when the repository check is off.
func checkTimerUnit(r repositoryCfg) string {
	cal := checkOnCalendar(r.Check)
	if cal == "" {
		return ""
	}
	return timerUnit("HSI backup repository check "+r.Name, cal, unitPrefix()+"-backup-check@"+r.ID+".service")
}

// systemctl runs systemctl; tests swap it.
var systemctl = func(args ...string) ([]byte, error) {
	return command("systemctl", args...).CombinedOutput()
}

// nextElapse is the next time the timer fires, nil when it is not scheduled.
func nextElapse(timer string) *time.Time {
	out, err := systemctl("show", "-p", "NextElapseUSecRealtime", "--value", timer)
	if err != nil {
		return nil
	}
	return parseElapse(strings.TrimSpace(string(out)), time.Local)
}

// parseElapse reads systemd's "Tue 2026-10-20 02:30:00 CEST" in loc. The zone name
// settles the hour that a DST change repeats; without one, the time is read as local.
func parseElapse(s string, loc *time.Location) *time.Time {
	if s == "" || s == "n/a" {
		return nil
	}
	f := strings.Fields(s)
	if len(f) < 3 {
		return nil
	}
	if len(f) >= 4 {
		if t, err := time.ParseInLocation("2006-01-02 15:04:05 MST", f[1]+" "+f[2]+" "+f[3], loc); err == nil && knownZone(t, loc) {
			return &t
		}
	}
	if t, err := time.ParseInLocation("2006-01-02 15:04:05", f[1]+" "+f[2], loc); err == nil {
		return &t
	}
	return nil
}

// knownZone tells whether the zone name was read as a zone of loc (or UTC): for a name
// it does not know, time.Parse makes up a zone with a zero offset.
func knownZone(t time.Time, loc *time.Location) bool {
	return t.Location() == loc || t.Location() == time.UTC
}

// writeTimerSteps brings the timer file at path to content ("" removes it) and
// enables or disables the timer. It returns no step when nothing changes.
func writeTimerSteps(path, content string) []planStep {
	name := filepath.Base(path)
	before, readErr := os.ReadFile(path)
	exists := readErr == nil
	reload := cmdStep(name, "Reload systemd", []string{"systemctl", "daemon-reload"})
	if content == "" {
		if !exists {
			return nil
		}
		disable := cmdStep(name, "Stop the timer "+name, []string{"systemctl", "disable", "--now", name})
		disable.OnFailure = "ignore"
		del := planStep{Kind: "delete", Target: path, Summary: "Remove the timer " + name,
			Diff: unifiedDiff(path, string(before), ""),
			run:  func() (string, error) { return "", os.Remove(path) }}
		return []planStep{disable, del, reload}
	}
	if exists && string(before) == content {
		return nil
	}
	kind, summary := "create", "Create the timer "+name
	if exists {
		kind, summary = "update", "Update the timer "+name
	}
	write := planStep{Kind: kind, Target: path, Summary: summary,
		Diff: unifiedDiff(path, string(before), content),
		run: func() (string, error) {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return "", err
			}
			if err := writeBackupFile(path, []byte(content), 0o644); err != nil {
				return "", fmt.Errorf("write %s: %w", path, err)
			}
			return "", nil
		}}
	return []planStep{write, reload, cmdStep(name, "Start the timer "+name, []string{"systemctl", "enable", "--now", name})}
}
