package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// ── NATS reads and actions for versioned backups (#15) ──────────────────────

type planStatus struct {
	backupPlanCfg
	NextRun  *time.Time      `json:"nextRun"`
	Last     *runRecord      `json:"last"`
	Progress *backupProgress `json:"progress"`
}

type repoStatus struct {
	repositoryCfg
	HasPassword bool       `json:"hasPassword"`
	NextCheck   *time.Time `json:"nextCheck"`
	LastCheck   *runRecord `json:"lastCheck"`
}

func firstRun(kind, id string) *runRecord {
	runs, err := lastRuns(kind, id, 1)
	if err != nil || len(runs) == 0 {
		return nil
	}
	return &runs[0]
}

// backupStatus is everything the backup page shows, without any secret.
func backupStatus() map[string]any {
	cfg, exists, _ := loadBackupConfig()
	version, installed := resticVersion()
	plans := []planStatus{}
	for _, p := range cfg.Plans {
		st := planStatus{backupPlanCfg: p, Last: firstRun("runs", p.ID)}
		if planTimerUnit(p) != "" {
			st.NextRun = nextElapse(planTimerName(p.ID))
		}
		if prog, ok := liveProgress(p.ID); ok {
			st.Progress = prog
		}
		plans = append(plans, st)
	}
	repos := []repoStatus{}
	for _, r := range cfg.Repositories {
		st := repoStatus{repositoryCfg: r, LastCheck: firstRun("checks", r.ID)}
		if sec, err := readRepoSecrets(r.ID); err == nil && sec.Password != "" {
			st.HasPassword = true
		}
		if checkTimerUnit(r) != "" {
			st.NextCheck = nextElapse(checkTimerName(r.ID))
		}
		repos = append(repos, st)
	}
	return map[string]any{
		"configExists":     exists,
		"engine":           map[string]any{"installed": installed, "version": version},
		"plans":            plans,
		"repositories":     repos,
		"migrationSkipped": migrationSkipped(),
	}
}

func invalidInput(msg string) *fsError { return &fsError{Code: "EINVAL", Message: msg} }

// repoAndSecrets validates the repository id before it is used for anything.
func repoAndSecrets(id string) (repositoryCfg, repoSecrets, *fsError) {
	if !backupIDPattern.MatchString(id) {
		return repositoryCfg{}, repoSecrets{}, invalidInput("Invalid repository")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return repositoryCfg{}, repoSecrets{}, fe
	}
	repo, ok := cfg.repository(id)
	if !ok {
		return repositoryCfg{}, repoSecrets{}, &fsError{Code: "ENOENT", Message: "This repository does not exist"}
	}
	sec, err := readRepoSecrets(id)
	if err != nil {
		return repositoryCfg{}, repoSecrets{}, &fsError{Code: "ERR", Message: "The repository password is not readable"}
	}
	return repo, sec, nil
}

type snapshotInfo struct {
	snapshot
	Consistent bool   `json:"consistent"`
	Plan       string `json:"plan"`
}

func snapshotView(s snapshot) snapshotInfo {
	v := snapshotInfo{snapshot: s}
	for _, t := range s.Tags {
		if t == "consistent" {
			v.Consistent = true
		}
		if id, ok := strings.CutPrefix(t, "plan:"); ok {
			v.Plan = id
		}
	}
	return v
}

// backupSnapshots lists a repository's snapshots, newest first.
func backupSnapshots(repository string) ([]snapshotInfo, *fsError) {
	repo, sec, fe := repoAndSecrets(repository)
	if fe != nil {
		return nil, fe
	}
	if err := repositoryReady(repo); err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	list, err := resticSnapshots(repo, sec)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].Time.After(list[j].Time) })
	out := make([]snapshotInfo, 0, len(list))
	for _, s := range list {
		out = append(out, snapshotView(s))
	}
	return out, nil
}

// backupLs lists the children of a path in a snapshot, directories first.
func backupLs(repository, snapshotID, path string) ([]lsEntry, *fsError) {
	if !backupSnapshotPattern.MatchString(snapshotID) {
		return nil, invalidInput("Invalid snapshot")
	}
	clean, err := cleanBackupPath(path)
	// The snapshot root is browsable, though it is never a backup source.
	if path == "/" {
		clean, err = "/", nil
	}
	if err != nil {
		return nil, invalidInput("Invalid path")
	}
	repo, sec, fe := repoAndSecrets(repository)
	if fe != nil {
		return nil, fe
	}
	if err := repositoryReady(repo); err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	entries, err := resticLs(repo, sec, snapshotID, clean)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		di, dj := entries[i].Type == "dir", entries[j].Type == "dir"
		if di != dj {
			return di
		}
		return entries[i].Name < entries[j].Name
	})
	return entries, nil
}

func backupRunNow(id string) *fsError {
	if !backupIDPattern.MatchString(id) {
		return invalidInput("Invalid backup plan")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return fe
	}
	if _, ok := cfg.plan(id); !ok {
		return &fsError{Code: "ENOENT", Message: "This backup plan does not exist"}
	}
	if runActive(id) {
		return &fsError{Code: "EBUSY", Message: "This backup plan is running"}
	}
	// A transient unit rather than the plan's own: only a run started by hand may run
	// a paused plan, and the timer's unit cannot tell the two apart.
	exe, err := os.Executable()
	if err != nil {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
	argv := []string{"systemd-run", "--unit", unitPrefix() + "-backup-run-" + id, "--collect",
		"-p", "Nice=10", "-p", "IOSchedulingClass=idle", "-p", "TimeoutStopSec=" + backupStopTimeout}
	argv = append(argv, hsiEnvArgs(os.Environ())...)
	argv = append(argv, exe, "backup", "run", id, "--manual")
	if out, err := runArgv(argv); err != nil {
		return &fsError{Code: "ERR", Message: cmdErrMessage(out, err)}
	}
	return nil
}

// backupStopTimeout leaves an interrupted run the time to start its apps again, as the
// TimeoutStopSec= of the backup units does.
const backupStopTimeout = "120s"

func backupCheckNow(id string, full bool) *fsError {
	if !backupIDPattern.MatchString(id) {
		return invalidInput("Invalid repository")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return fe
	}
	if _, ok := cfg.repository(id); !ok {
		return &fsError{Code: "ENOENT", Message: "This repository does not exist"}
	}
	if !full {
		if out, err := systemctl("start", "--no-block", unitPrefix()+"-backup-check@"+id+".service"); err != nil {
			return &fsError{Code: "ERR", Message: cmdErrMessage(out, err)}
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
	argv := []string{"systemd-run", "--unit", unitPrefix() + "-backup-check-full-" + id, "--collect",
		"-p", "Nice=10", "-p", "IOSchedulingClass=idle", "-p", "TimeoutStopSec=" + backupStopTimeout}
	argv = append(argv, hsiEnvArgs(os.Environ())...)
	argv = append(argv, exe, "backup", "check", id, "--full")
	if out, err := runArgv(argv); err != nil {
		return &fsError{Code: "ERR", Message: cmdErrMessage(out, err)}
	}
	return nil
}

// ── Migration of the former rsync plans ─────────────────────────────────────

func rowString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}

func rowInt(row map[string]any, key string) int {
	switch v := row[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 0
}

func rowExcludes(row map[string]any) []string {
	out := []string{}
	switch v := row["excludes"].(type) {
	case string:
		_ = json.Unmarshal([]byte(v), &out)
	case []any:
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
	case []string:
		out = v
	}
	return out
}

// planFromRsyncRow converts a row of the former backup plan table to a sync plan.
func planFromRsyncRow(row map[string]any) backupPlanCfg {
	port := rowInt(row, "remotePort")
	if port == 0 {
		port = 22
	}
	enabled, _ := row["enabled"].(bool)
	deleteExtra, _ := row["deleteExtra"].(bool)
	compress, _ := row["compress"].(bool)
	return backupPlanCfg{
		ID: rowString(row, "id"), Name: rowString(row, "name"), Type: "sync", Enabled: enabled,
		Schedule: backupSchedule{Every: rowString(row, "schedule"), Hour: rowInt(row, "scheduleHour"),
			Minute: rowInt(row, "scheduleMinute"), Weekday: rowInt(row, "scheduleWeekday")},
		Sync: &syncOptions{Direction: rowString(row, "direction"), Source: rowString(row, "source"),
			Destination: rowString(row, "destination"), RemoteHost: rowString(row, "remoteHost"),
			RemoteUser: rowString(row, "remoteUser"), RemotePort: port, SSHKeyPath: rowString(row, "sshKeyPath"),
			DeleteExtra: deleteExtra, Compress: compress, BandwidthLimit: rowInt(row, "bandwidthLimit"),
			Excludes: rowExcludes(row)},
	}
}

// migrateRsyncPlans turns the former rsync plan rows into sync plans, once: nothing
// happens when backup.json already exists. Invalid rows are skipped and reported.
func migrateRsyncPlans(rows []map[string]any) (int, []map[string]string, error) {
	skipped := []map[string]string{}
	if _, exists, err := loadBackupConfig(); err != nil || exists {
		return 0, skipped, err
	}
	cfg := backupConfig{}
	seen := map[string]bool{}
	for _, row := range rows {
		p := planFromRsyncRow(row)
		err := validatePlan(p, map[string]bool{})
		switch {
		case !backupIDPattern.MatchString(p.ID):
			err = fmt.Errorf("invalid plan id")
		case seen[p.ID]:
			err = fmt.Errorf("duplicate plan id")
		}
		if err != nil {
			skipped = append(skipped, map[string]string{"name": p.Name, "error": err.Error()})
			continue
		}
		seen[p.ID] = true
		cfg.Plans = append(cfg.Plans, p)
	}
	if len(cfg.Plans) == 0 && len(skipped) == 0 {
		return 0, skipped, nil
	}
	// backup.json marks the migration done, so it is written last: a failed timer
	// leaves no configuration and the backend retries the whole migration.
	if err := writeAllTimers(cfg); err != nil {
		return 0, skipped, err
	}
	if err := saveMigrationSkipped(skipped); err != nil {
		return 0, skipped, err
	}
	if err := saveBackupConfig(cfg); err != nil {
		return 0, skipped, err
	}
	return len(cfg.Plans), skipped, nil
}

func migrationSkippedPath() string {
	return filepath.Join(backupStateDir(), "migration-skipped.json")
}

// saveMigrationSkipped keeps the plans the migration could not convert, shown until
// the admin dismisses them.
func saveMigrationSkipped(skipped []map[string]string) error {
	if len(skipped) == 0 {
		return dismissMigrationSkipped()
	}
	raw, err := json.Marshal(skipped)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(backupStateDir(), 0o755); err != nil {
		return err
	}
	return writeBackupFile(migrationSkippedPath(), raw, 0o644)
}

func migrationSkipped() []map[string]string {
	out := []map[string]string{}
	raw, err := os.ReadFile(migrationSkippedPath())
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func dismissMigrationSkipped() error {
	if err := os.Remove(migrationSkippedPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// syncBackupTimers runs once at worker start: the host's backup timers follow
// backup.json, whatever an earlier failure left.
func syncBackupTimers() {
	cfg, exists, err := loadBackupConfig()
	if err != nil || !exists {
		if err != nil {
			logger.Warn("backup timers not checked", "error", err.Error())
		}
		return
	}
	if err := writeAllTimers(cfg); err != nil {
		logger.Warn("backup timers not written", "error", err.Error())
	}
}

// staleTimers lists the backup timers on the host that are not in keep.
func staleTimers(keep map[string]string) []string {
	var out []string
	for _, kind := range []string{"-backup@", "-backup-check@"} {
		found, _ := filepath.Glob(filepath.Join(systemdDir(), unitPrefix()+kind+"*.timer"))
		for _, path := range found {
			name := filepath.Base(path)
			id := strings.TrimSuffix(strings.TrimPrefix(name, unitPrefix()+kind), ".timer")
			if _, ok := keep[name]; !ok && backupIDPattern.MatchString(id) {
				out = append(out, name)
			}
		}
	}
	sort.Strings(out)
	return out
}

// writeAllTimers writes the timer of every plan and repository of cfg, removes the
// other backup timers of the host, reloads systemd once and enables each timer. The new
// timers are written before any is removed, and an unchanged host only gets enabled.
func writeAllTimers(cfg backupConfig) error {
	timers := map[string]string{}
	for _, p := range cfg.Plans {
		if u := planTimerUnit(p); u != "" {
			timers[planTimerName(p.ID)] = u
		}
	}
	for _, r := range cfg.Repositories {
		if u := checkTimerUnit(r); u != "" {
			timers[checkTimerName(r.ID)] = u
		}
	}
	names := make([]string, 0, len(timers))
	for name := range timers {
		names = append(names, name)
	}
	sort.Strings(names)
	stale := staleTimers(timers)
	if len(names) == 0 && len(stale) == 0 {
		return nil
	}
	if err := os.MkdirAll(systemdDir(), 0o755); err != nil {
		return err
	}
	changed := len(stale) > 0
	for _, name := range names {
		path := filepath.Join(systemdDir(), name)
		if cur, err := os.ReadFile(path); err == nil && string(cur) == timers[name] {
			continue
		}
		changed = true
		if err := writeBackupFile(path, []byte(timers[name]), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
	}
	// A timer of a plan or repository that is gone, disabled or manual must stop.
	for _, name := range stale {
		_, _ = systemctl("disable", "--now", name)
		if err := os.Remove(filepath.Join(systemdDir(), name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if changed {
		if out, err := systemctl("daemon-reload"); err != nil {
			return fmt.Errorf("systemctl daemon-reload: %s", cmdErrMessage(out, err))
		}
	}
	for _, name := range names {
		if out, err := systemctl("enable", "--now", name); err != nil {
			return fmt.Errorf("systemctl enable --now %s: %s", name, cmdErrMessage(out, err))
		}
	}
	return nil
}

// ── Handlers ────────────────────────────────────────────────────────────────

func decodeBackupRequest(nc *nats.Conn, msg *nats.Msg, req any) bool {
	if err := json.Unmarshal(msg.Data, req); err != nil {
		replyErr(nc, msg.Reply, invalidInput("Invalid request"))
		return false
	}
	return true
}

func replyResult(nc *nats.Conn, msg *nats.Msg, result any, fe *fsError) {
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, result)
}

func handleBackupStatus(nc *nats.Conn, msg *nats.Msg) { replyOk(nc, msg.Reply, backupStatus()) }

func handleBackupRuns(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Kind  string `json:"kind"`
		ID    string `json:"id"`
		Limit int    `json:"limit"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	if (req.Kind != "runs" && req.Kind != "checks" && req.Kind != "restores") || !backupIDPattern.MatchString(req.ID) {
		replyErr(nc, msg.Reply, invalidInput("Invalid request"))
		return
	}
	if req.Limit < 1 || req.Limit > maxRunLines {
		req.Limit = maxRunLines
	}
	runs, err := lastRuns(req.Kind, req.ID, req.Limit)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, runs)
}

func handleBackupRunNow(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		ID string `json:"id"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	replyResult(nc, msg, map[string]any{"ok": true}, backupRunNow(req.ID))
}

func handleBackupCheckNow(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		ID   string `json:"id"`
		Full bool   `json:"full"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	replyResult(nc, msg, map[string]any{"ok": true}, backupCheckNow(req.ID, req.Full))
}

func handleBackupSnapshots(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Repository string `json:"repository"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	list, fe := backupSnapshots(req.Repository)
	replyResult(nc, msg, list, fe)
}

func handleBackupLs(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Repository string `json:"repository"`
		Snapshot   string `json:"snapshot"`
		Path       string `json:"path"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	list, fe := backupLs(req.Repository, req.Snapshot, req.Path)
	replyResult(nc, msg, list, fe)
}

// handleBackupPassword returns the stored password only; the backend asks the
// user to re-authenticate before it calls this.
func handleBackupPassword(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Repository string `json:"repository"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	_, sec, fe := repoAndSecrets(req.Repository)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"password": sec.Password})
}

// restoreQueuedFor is how long a restore request waits for its unit to take the run
// lock; an older request whose run holds no lock was left by a run that died.
const restoreQueuedFor = 2 * time.Minute

// backupRestoreStatus reports a restore by its run id: its progress while it is queued
// or runs, then its record, looked up in the restore logs of every repository. A run
// that is none of these is unknown: both are null.
func backupRestoreStatus(runID string) map[string]any {
	out := map[string]any{"progress": nil, "result": nil}
	if runActive(runID) {
		p, ok := readProgress(runID)
		if !ok {
			p = &backupProgress{}
		}
		out["progress"] = p
		return out
	}
	clearProgress(runID)
	request := filepath.Join(backupStateDir(), "restores", runID+".json")
	if st, err := os.Stat(request); err == nil && time.Since(st.ModTime()) < restoreQueuedFor {
		out["progress"] = &backupProgress{}
		return out
	}
	logs, _ := filepath.Glob(filepath.Join(backupStateDir(), "restores", "*.jsonl"))
	for _, path := range logs {
		id := strings.TrimSuffix(filepath.Base(path), ".jsonl")
		runs, _ := lastRuns("restores", id, maxRunLines)
		for i := range runs {
			if runs[i].RunID == runID {
				out["result"] = &runs[i]
				return out
			}
		}
	}
	return out
}

func handleBackupRestoreStatus(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		RunID string `json:"runId"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	if !backupIDPattern.MatchString(req.RunID) {
		replyErr(nc, msg.Reply, invalidInput("Invalid request"))
		return
	}
	replyOk(nc, msg.Reply, backupRestoreStatus(req.RunID))
}

func handleBackupMigrate(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Plans []map[string]any `json:"plans"`
	}
	if !decodeBackupRequest(nc, msg, &req) {
		return
	}
	n, skipped, err := migrateRsyncPlans(req.Plans)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"migrated": n, "skipped": skipped})
}

func handleBackupMigrationDismiss(nc *nats.Conn, msg *nats.Msg) {
	if err := dismissMigrationSkipped(); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}
