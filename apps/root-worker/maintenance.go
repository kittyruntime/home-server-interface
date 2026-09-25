package main

import (
	"encoding/json"
	"errors"
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
	Status  string `json:"status"` // started | skipped | error
	Message string `json:"message,omitempty"`
}

type taskState struct {
	LastRun *time.Time   `json:"lastRun,omitempty"`
	Results []taskResult `json:"results"`
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
	case err == nil:
		return "started", ""
	}
	return "error", cmdErrMessage([]byte(out), err)
}

func runSmartTests(kind string) []taskResult {
	results := []taskResult{}
	if _, err := exec.LookPath("smartctl"); err != nil {
		return append(results, taskResult{Status: "error", Message: "smartctl is not installed (sudo apt install smartmontools)"})
	}
	out, err := exec.Command("lsblk", "-dn", "-P", "-o", "NAME,TYPE,SERIAL").Output()
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
		sout, serr := exec.Command("smartctl", "-n", "standby", "-t", kind, dev).CombinedOutput()
		status, msg := classifySelfTestStart(string(sout), serr)
		results = append(results, taskResult{Device: fields["NAME"], Serial: fields["SERIAL"], Status: status, Message: msg})
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
			return append(results, taskResult{Device: a.Name, Status: "skipped", Message: "an array is syncing (" + a.SyncAction + "); checks resume at the next scheduled run"})
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

func runMaintenanceTask(task string) []taskResult {
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
		state[task] = taskState{LastRun: &started, Results: results}
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

// runMaintenanceCLI is `hsi-root-worker maintenance`, run hourly by
// hsi-maintenance.timer.
func runMaintenanceCLI() int {
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
			"schedule": cfg.schedule(t),
			"lastRun":  state[t].LastRun,
			"results":  state[t].Results,
			"nextRun":  cfg.schedule(t).nextRun(now),
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
