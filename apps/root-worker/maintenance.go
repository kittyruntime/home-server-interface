package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

var (
	maintenanceConfigPath = envOr("HSI_MAINTENANCE_CONFIG", "/etc/hsi/maintenance.json")
	maintenanceStatePath  = envOr("HSI_MAINTENANCE_STATE", "/var/lib/hsi/maintenance-state.json")
	maintenanceTimerPath  = envOr("HSI_MAINTENANCE_TIMER", "/etc/systemd/system/hsi-maintenance.timer")
	maintenanceLockPath   = envOr("HSI_MAINTENANCE_LOCK", "/run/hsi-maintenance.lock")
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var maintenanceTasks = []string{"smartShort", "smartLong", "raidCheck"}

type taskResult struct {
	Device  string `json:"device"`
	Serial  string `json:"serial,omitempty"`
	Status  string `json:"status"` // started | skipped | error; read back as running | passed | failed
	Message string `json:"message,omitempty"`
	// LogCount: entries in the disk's self-test log when HSI started the test,
	// so its outcome is the entry that comes after.
	LogCount *int `json:"logCount,omitempty"`
}

// smartSelfTestJSON is the part of `smartctl -j -c -l selftest` HSI reads.
type smartSelfTestJSON struct {
	Data *struct {
		SelfTest struct {
			Status struct {
				Value     int `json:"value"`
				Remaining int `json:"remaining_percent"`
			} `json:"status"`
		} `json:"self_test"`
	} `json:"ata_smart_data"`
	Log *struct {
		Standard struct {
			Count int `json:"count"`
			Table []struct {
				Status struct {
					String string `json:"string"`
					Passed bool   `json:"passed"`
				} `json:"status"`
			} `json:"table"`
		} `json:"standard"`
	} `json:"ata_smart_self_test_log"`
}

// hostSelfTestJSON reads a disk's self-test state without waking it up.
var hostSelfTestJSON = func(dev string) []byte {
	out, _ := command("smartctl", "-n", "standby", "-j", "-c", "-l", "selftest", dev).Output()
	return out
}

// refreshSelfTests reads the outcome of the self-tests HSI started.
func refreshSelfTests(results []taskResult) []taskResult {
	out := make([]taskResult, len(results))
	for i, r := range results {
		out[i] = r
		if r.Status == "started" && r.LogCount != nil && r.Device != "" {
			out[i].Status, out[i].Message = selfTestOutcome(hostSelfTestJSON("/dev/"+r.Device), *r.LogCount)
		}
	}
	return out
}

// selfTestLogCount is the number of entries in a disk's self-test log, or nil.
func selfTestLogCount(dev string) *int {
	var d smartSelfTestJSON
	if json.Unmarshal(hostSelfTestJSON(dev), &d) != nil || d.Log == nil {
		return nil
	}
	n := d.Log.Standard.Count
	return &n
}

// selfTestOutcome reads the outcome of a test started when the self-test log
// had startCount entries: running, then passed or failed once its entry is
// logged. Anything it cannot tell stays "started".
func selfTestOutcome(js []byte, startCount int) (status, message string) {
	var d smartSelfTestJSON
	if json.Unmarshal(js, &d) != nil || d.Data == nil || d.Log == nil {
		return "started", ""
	}
	// ATA execution status 0xF_: a self-test is in progress.
	if v := d.Data.SelfTest.Status.Value; v >= 240 && v <= 255 {
		return "running", fmt.Sprintf("%d%% remaining", d.Data.SelfTest.Status.Remaining)
	}
	if d.Log.Standard.Count > startCount && len(d.Log.Standard.Table) > 0 {
		top := d.Log.Standard.Table[0]
		if top.Status.Passed {
			return "passed", ""
		}
		return "failed", top.Status.String
	}
	return "started", ""
}

type taskState struct {
	LastRun *time.Time   `json:"lastRun,omitempty"`
	Results []taskResult `json:"results"`
	// Postponed: the latest attempt could start nothing (an array syncing,
	// every disk asleep). It is not a run: the hourly timer tries again.
	Postponed *postponed `json:"postponed,omitempty"`
}

type postponed struct {
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
}

type maintenanceState map[string]taskState

func (c maintenanceConfig) schedule(task string) taskSchedule {
	switch task {
	case "smartShort":
		return c.SmartShort
	case "smartLong":
		return c.SmartLong
	default:
		return c.RaidCheck
	}
}

func loadMaintenanceConfig() maintenanceConfig {
	cfg := defaultMaintenanceConfig()
	if data, err := os.ReadFile(maintenanceConfigPath); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func loadMaintenanceState() maintenanceState {
	st := maintenanceState{}
	if data, err := os.ReadFile(maintenanceStatePath); err == nil {
		_ = json.Unmarshal(data, &st)
	}
	return st
}

func saveJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o644)
}

// classifySelfTestStart interprets `smartctl -n standby -t short|long` output.
func classifySelfTestStart(out string, err error) (status, message string) {
	switch {
	case strings.Contains(out, "Testing has begun") || strings.Contains(out, "Self-test has begun") || strings.Contains(out, "Self Test has begun"):
		return "started", ""
	case strings.Contains(out, "STANDBY") || strings.Contains(strings.ToLower(out), "standby mode"):
		return "skipped", "disk in standby, not woken up; retried at the next scheduled run"
	case strings.Contains(out, "without aborting current test") || strings.Contains(out, "in progress"):
		return "skipped", "a self-test is already running"
	case strings.Contains(out, "Unable to detect device type") || strings.Contains(out, "SMART support is: Unavailable") || strings.Contains(out, "does not support"):
		return "skipped", "no SMART self-test support (virtual disk or USB bridge)"
	case strings.Contains(out, "unsupported scsi opcode") || strings.Contains(out, "not supported"):
		return "skipped", "this disk does not run SMART self-tests"
	case err == nil:
		return "started", ""
	}
	return "error", cmdErrMessage([]byte(withoutSmartctlBanner(out)), err)
}

// withoutSmartctlBanner drops the version and copyright lines smartctl prints
// before every answer.
func withoutSmartctlBanner(out string) string {
	var keep []string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "smartctl ") || strings.HasPrefix(l, "Copyright (C)") {
			continue
		}
		keep = append(keep, l)
	}
	return strings.TrimSpace(strings.Join(keep, "\n"))
}

func runSmartTests(kind string) []taskResult {
	results := []taskResult{}
	if _, err := exec.LookPath("smartctl"); err != nil {
		return append(results, taskResult{Status: "error", Message: "smartctl is not installed (sudo apt install smartmontools)"})
	}
	out, err := command("lsblk", "-dn", "-P", "-o", "NAME,TYPE,SERIAL").Output()
	if err != nil {
		return append(results, taskResult{Status: "error", Message: "lsblk failed: " + err.Error()})
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := map[string]string{}
		for _, m := range reLsblkPair.FindAllStringSubmatch(line, -1) {
			fields[m[1]] = m[2]
		}
		if fields["TYPE"] != "disk" || fields["NAME"] == "" {
			continue
		}
		dev := "/dev/" + fields["NAME"]
		count := selfTestLogCount(dev)
		sout, serr := command("smartctl", "-n", "standby", "-t", kind, dev).CombinedOutput()
		status, msg := classifySelfTestStart(string(sout), serr)
		r := taskResult{Device: fields["NAME"], Serial: fields["SERIAL"], Status: status, Message: msg}
		if status == "started" {
			r.LogCount = count
		}
		results = append(results, r)
	}
	return results
}

// runRaidChecks starts an md consistency check on every redundant array,
// unless an array is already syncing (rebuild, reshape, another check):
// checks are never stacked on top of a rebuild.
func runRaidChecks() []taskResult {
	results := []taskResult{}
	mdData, _ := os.ReadFile("/proc/mdstat")
	arrays := parseMdstat(string(mdData))
	for _, a := range arrays {
		if a.ResyncPercent != nil {
			return append(results, taskResult{Device: a.Name, Status: "skipped", Message: "an array is syncing (" + a.SyncAction + ")"})
		}
	}
	for _, a := range arrays {
		if a.Level == "raid0" || a.Level == "linear" {
			results = append(results, taskResult{Device: a.Name, Status: "skipped", Message: "no redundancy to check"})
			continue
		}
		actionPath := "/sys/block/" + a.Name + "/md/sync_action"
		if cur, err := os.ReadFile(actionPath); err == nil && strings.TrimSpace(string(cur)) != "idle" {
			results = append(results, taskResult{Device: a.Name, Status: "skipped", Message: "busy: " + strings.TrimSpace(string(cur))})
			continue
		}
		if err := os.WriteFile(actionPath, []byte("check"), 0o644); err != nil {
			results = append(results, taskResult{Device: a.Name, Status: "error", Message: err.Error()})
			continue
		}
		results = append(results, taskResult{Device: a.Name, Status: "started"})
	}
	return results
}

var runMaintenanceTask = func(task string) []taskResult {
	switch task {
	case "smartShort":
		return runSmartTests("short")
	case "smartLong":
		return runSmartTests("long")
	default:
		return runRaidChecks()
	}
}

var errMaintenanceBusy = errors.New("maintenance is already running")

// allSkipped reports whether nothing started in a run, with the first reason.
func allSkipped(results []taskResult) (string, bool) {
	if len(results) == 0 {
		return "", false
	}
	for _, r := range results {
		if r.Status != "skipped" {
			return "", false
		}
	}
	return results[0].Message, true
}

// runMaintenance runs every due task (or only `only` when set, regardless of
// its schedule). A lock file keeps the timer and a manual run from overlapping.
func runMaintenance(now time.Time, only string) error {
	lock, err := os.OpenFile(maintenanceLockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errMaintenanceBusy
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	cfg := loadMaintenanceConfig()
	state := loadMaintenanceState()
	for _, task := range maintenanceTasks {
		if only != "" && task != only {
			continue
		}
		prev := state[task]
		if only == "" && !cfg.schedule(task).isDue(now, prev.LastRun) {
			continue
		}
		results := runMaintenanceTask(task)
		started := now
		if reason, all := allSkipped(results); all {
			state[task] = taskState{LastRun: prev.LastRun, Results: prev.Results, Postponed: &postponed{At: now, Reason: reason}}
		} else {
			state[task] = taskState{LastRun: &started, Results: results}
		}
		for _, r := range results {
			level := logger.Info
			if r.Status == "error" {
				level = logger.Warn
			}
			level("maintenance", "task", task, "device", r.Device, "serial", r.Serial, "status", r.Status, "message", r.Message)
		}
		if err := saveJSON(maintenanceStatePath, state); err != nil {
			logger.Error("maintenance: could not save state", "error", err.Error())
		}
	}
	return nil
}

// runMaintenanceCLI is `hsi-worker maintenance`, run hourly by
// hsi-maintenance.timer.
func runMaintenanceCLI() int {
	// The fallback for expansions when the worker daemon is down (#7).
	finishExpansions(time.Now())
	if err := runMaintenance(time.Now(), ""); err != nil {
		logger.Warn("maintenance run skipped", "error", err.Error())
		if errors.Is(err, errMaintenanceBusy) {
			return 0
		}
		return 1
	}
	return 0
}

// ── NATS requests from the dashboard ─────────────────────────────────────────

func handleMaintenanceGet(nc *nats.Conn, msg *nats.Msg) {
	cfg := loadMaintenanceConfig()
	state := loadMaintenanceState()
	now := time.Now()
	tasks := map[string]any{}
	for _, t := range maintenanceTasks {
		tasks[t] = map[string]any{
			"schedule":  cfg.schedule(t),
			"lastRun":   state[t].LastRun,
			"postponed": state[t].Postponed,
			"results":   refreshSelfTests(state[t].Results),
			"nextRun":   cfg.schedule(t).nextRun(now),
		}
	}
	_, timerErr := os.Stat(maintenanceTimerPath)
	replyOk(nc, msg.Reply, map[string]any{"tasks": tasks, "timerInstalled": timerErr == nil})
}

func handleMaintenanceSet(nc *nats.Conn, msg *nats.Msg) {
	var cfg maintenanceConfig
	if err := json.Unmarshal(msg.Data, &cfg); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	for _, t := range maintenanceTasks {
		if !cfg.schedule(t).valid() {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid schedule for " + t})
			return
		}
	}
	if err := saveJSON(maintenanceConfigPath, cfg); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "could not save " + maintenanceConfigPath + ": " + err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleMaintenanceRunNow(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Task string `json:"task"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || !containsString(maintenanceTasks, req.Task) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "unknown maintenance task"})
		return
	}
	if err := runMaintenance(time.Now(), req.Task); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "EBUSY", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true, "state": loadMaintenanceState()[req.Task]})
}
