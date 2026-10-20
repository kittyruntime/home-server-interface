package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ── Plan builders: backup plans, repositories and restores (#15) ────────────

var backupSnapshotPattern = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

func invalid(msg string) *fsError { return &fsError{Code: "EINVALID", Message: msg} }

// randomPassword is 32 random bytes, base64url without padding.
func randomPassword() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// newRunID is a random UUID, so it passes backupIDPattern.
func newRunID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func loadBackupConfigFsErr() (backupConfig, *fsError) {
	c, _, err := loadBackupConfig()
	if err != nil {
		return c, &fsError{Code: "ERR", Message: err.Error()}
	}
	return c, nil
}

func backupObserved() map[string]string {
	raw, _ := os.ReadFile(backupConfigPath())
	return map[string]string{"backup": string(raw)}
}

// backupConfigStep writes backup.json with the change, showing its diff.
func backupConfigStep(summary string, next backupConfig) planStep {
	if next.Plans == nil {
		next.Plans = []backupPlanCfg{}
	}
	if next.Repositories == nil {
		next.Repositories = []repositoryCfg{}
	}
	before, readErr := os.ReadFile(backupConfigPath())
	after, _ := json.MarshalIndent(next, "", "  ")
	kind := "update"
	if readErr != nil {
		kind = "create"
	}
	return planStep{Kind: kind, Target: backupConfigPath(), Summary: summary,
		Diff: unifiedDiff(backupConfigPath(), string(before), string(after)+"\n"),
		run:  func() (string, error) { return "", saveBackupConfig(next) }}
}

func withPlan(c backupConfig, p backupPlanCfg) backupConfig {
	out := c
	out.Plans = append([]backupPlanCfg{}, c.Plans...)
	for i := range out.Plans {
		if out.Plans[i].ID == p.ID {
			out.Plans[i] = p
			return out
		}
	}
	out.Plans = append(out.Plans, p)
	return out
}

func withoutPlan(c backupConfig, id string) backupConfig {
	out := c
	out.Plans = []backupPlanCfg{}
	for _, p := range c.Plans {
		if p.ID != id {
			out.Plans = append(out.Plans, p)
		}
	}
	return out
}

func withRepository(c backupConfig, r repositoryCfg) backupConfig {
	out := c
	out.Repositories = append([]repositoryCfg{}, c.Repositories...)
	for i := range out.Repositories {
		if out.Repositories[i].ID == r.ID {
			out.Repositories[i] = r
			return out
		}
	}
	out.Repositories = append(out.Repositories, r)
	return out
}

func withoutRepository(c backupConfig, id string) backupConfig {
	out := c
	out.Repositories = []repositoryCfg{}
	for _, r := range c.Repositories {
		if r.ID != id {
			out.Repositories = append(out.Repositories, r)
		}
	}
	return out
}

func planBackupPlanSave(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Plan backupPlanCfg `json:"plan"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, invalid("Invalid request")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	next := withPlan(cfg, req.Plan)
	if err := next.validate(); err != nil {
		return nil, invalid(err.Error())
	}
	if v := req.Plan.Versions; v != nil {
		for _, app := range v.StopApps {
			if !fileExists(filepath.Join(containersDir, app, "compose.yaml")) {
				return nil, invalid("The app " + app + " does not exist")
			}
		}
	}
	steps := []planStep{backupConfigStep("Save the backup plan "+req.Plan.Name, next)}
	steps = append(steps, writeTimerSteps(filepath.Join(systemdDir(), planTimerName(req.Plan.ID)), planTimerUnit(req.Plan))...)
	return &opPlan{Op: "backup.plan.save", Observed: backupObserved(), Steps: steps}, nil
}

func planBackupPlanRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !backupIDPattern.MatchString(req.ID) {
		return nil, invalid("Invalid backup plan")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	plan, ok := cfg.plan(req.ID)
	if !ok {
		return nil, &fsError{Code: "ENOENT", Message: "This backup plan does not exist"}
	}
	if _, running := readProgress(req.ID); running {
		return nil, &fsError{Code: "EBUSY", Message: "This backup plan is running"}
	}
	steps := writeTimerSteps(filepath.Join(systemdDir(), planTimerName(req.ID)), "")
	steps = append(steps, backupConfigStep("Remove the backup plan "+plan.Name+" (its run history is kept)", withoutPlan(cfg, req.ID)))
	return &opPlan{Op: "backup.plan.remove", Observed: backupObserved(), Steps: steps}, nil
}

// mergeSecrets keeps the stored value of every blank field, and the stored
// password always: it is the one that opens the repository.
func mergeSecrets(stored, given repoSecrets) repoSecrets {
	pick := func(g, s string) string {
		if g == "" {
			return s
		}
		return g
	}
	out := repoSecrets{
		Password:        pick(given.Password, stored.Password),
		SSHKeyPath:      pick(given.SSHKeyPath, stored.SSHKeyPath),
		AccessKeyID:     pick(given.AccessKeyID, stored.AccessKeyID),
		SecretAccessKey: pick(given.SecretAccessKey, stored.SecretAccessKey),
		RestUser:        pick(given.RestUser, stored.RestUser),
		RestPassword:    pick(given.RestPassword, stored.RestPassword),
	}
	if stored.Password != "" {
		out.Password = stored.Password
	}
	return out
}

func validSecrets(r repositoryCfg, s repoSecrets) error {
	for _, v := range []string{s.Password, s.SSHKeyPath, s.AccessKeyID, s.SecretAccessKey, s.RestUser, s.RestPassword} {
		if strings.ContainsAny(v, "\x00\r\n") {
			return fmt.Errorf("invalid credential")
		}
	}
	if r.Type == "sftp" {
		if _, err := cleanBackupPath(s.SSHKeyPath); err != nil {
			return fmt.Errorf("an SSH key path is required")
		}
	}
	return nil
}

func secretMark(v string) string {
	if v == "" {
		return ""
	}
	return "set"
}

func secretsMtime(id string) string {
	path, err := repoSecretsPath(id)
	if err != nil {
		return ""
	}
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return strconv.FormatInt(st.ModTime().UnixNano(), 10)
}

const msgRepositoryExists = "This location already holds a restic repository: enter its password to attach it"

func planRepositorySave(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Repository repositoryCfg `json:"repository"`
		Secrets    repoSecrets   `json:"secrets"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, invalid("Invalid request")
	}
	repo := req.Repository
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	next := withRepository(cfg, repo)
	if err := next.validate(); err != nil {
		return nil, invalid(err.Error())
	}
	_, exists := cfg.repository(repo.ID)
	var stored repoSecrets
	if exists {
		stored, _ = readRepoSecrets(repo.ID)
	}
	sec := mergeSecrets(stored, req.Secrets)
	if err := validSecrets(repo, sec); err != nil {
		return nil, invalid(err.Error())
	}
	location := resticRepository(repo)

	p := &opPlan{Op: "backup.repository.save", Reply: map[string]any{}}
	generate := false
	if !exists {
		// restic refuses an empty password: without one, a throwaway password
		// tells an empty location (exit 10) from an existing repository (exit 12).
		probeSec := sec
		if sec.Password == "" {
			probeSec.Password = randomPassword()
		}
		state, msg := resticProbe(repo, probeSec)
		switch {
		case state == probeUnreachable:
			if msg == "" {
				msg = "The location could not be reached"
			}
			return nil, &fsError{Code: "EUNREACHABLE", Message: msg}
		case state != probeEmpty && sec.Password == "":
			return nil, &fsError{Code: "EPASSWORD", Message: msgRepositoryExists}
		case state == probeWrongPassword:
			return nil, &fsError{Code: "EPASSWORD", Message: "Wrong password for this repository"}
		case state == probeEmpty:
			generate = sec.Password == ""
			p.Steps = append(p.Steps, planStep{Kind: "run", Target: location,
				Summary: "Create an encrypted restic repository at " + location,
				run: func() (string, error) {
					if generate {
						sec.Password = randomPassword()
					}
					if err := resticInit(repo, sec); err != nil {
						return "", err
					}
					if generate {
						p.Reply["password"] = sec.Password
					}
					return "", nil
				}})
		}
	}

	kind := "create"
	if secretsMtime(repo.ID) != "" {
		kind = "update"
	}
	secretsPath, _ := repoSecretsPath(repo.ID)
	p.Steps = append(p.Steps, planStep{Kind: kind, Target: secretsPath,
		Summary: "Store the repository secrets (readable by root only)",
		run:     func() (string, error) { return "", writeRepoSecrets(repo.ID, sec) }})
	p.Steps = append(p.Steps, backupConfigStep("Save the repository "+repo.Name, next))
	p.Steps = append(p.Steps, writeTimerSteps(filepath.Join(systemdDir(), checkTimerName(repo.ID)), checkTimerUnit(repo))...)

	p.FingerprintInput, _ = json.Marshal(map[string]any{"repository": repo, "secrets": map[string]string{
		"password": secretMark(req.Secrets.Password), "sshKeyPath": secretMark(req.Secrets.SSHKeyPath),
		"accessKeyId": secretMark(req.Secrets.AccessKeyID), "secretAccessKey": secretMark(req.Secrets.SecretAccessKey),
		"restUser": secretMark(req.Secrets.RestUser), "restPassword": secretMark(req.Secrets.RestPassword),
	}})
	p.Observed = backupObserved()
	p.Observed["secrets"] = secretsMtime(repo.ID)
	return p, nil
}

func planRepositoryRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !backupIDPattern.MatchString(req.ID) {
		return nil, invalid("Invalid repository")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	repo, ok := cfg.repository(req.ID)
	if !ok {
		return nil, &fsError{Code: "ENOENT", Message: "This repository does not exist"}
	}
	for _, pl := range cfg.Plans {
		if pl.Versions != nil && pl.Versions.Repository == req.ID {
			return nil, &fsError{Code: "EINUSE", Message: "Used by the plan " + pl.Name}
		}
	}
	steps := writeTimerSteps(filepath.Join(systemdDir(), checkTimerName(req.ID)), "")
	secretsPath, _ := repoSecretsPath(req.ID)
	steps = append(steps, planStep{Kind: "delete", Target: secretsPath, Summary: "Delete the repository secrets",
		run: func() (string, error) { return "", removeRepoSecrets(req.ID) }})
	steps = append(steps, backupConfigStep("Remove the repository "+repo.Name+". The backups stored at "+resticRepository(repo)+" are kept", withoutRepository(cfg, req.ID)))
	p := &opPlan{Op: "backup.repository.remove", Steps: steps, Observed: backupObserved()}
	p.Observed["secrets"] = secretsMtime(req.ID)
	return p, nil
}

// volumeMountFor is the mount point of the managed volume holding path, "" when none does.
func volumeMountFor(path string) string {
	vols, err := volumeStatuses()
	if err != nil {
		return ""
	}
	best := ""
	for _, v := range vols {
		mp := v.MountPoint
		if (path == mp || strings.HasPrefix(path, mp+"/")) && len(mp) > len(best) {
			best = mp
		}
	}
	return best
}

var unsafeNameChars = regexp.MustCompile(`[/\\\x00-\x1f\x7f]`)

type restoreRequest struct {
	RunID      string `json:"runId"`
	Repository string `json:"repository"`
	Snapshot   string `json:"snapshot"`
	Path       string `json:"path"`
	Target     string `json:"target"` // directory the files are restored under
}

func (r restoreRequest) validate() error {
	if !backupIDPattern.MatchString(r.RunID) || !backupIDPattern.MatchString(r.Repository) {
		return fmt.Errorf("invalid restore request")
	}
	if !backupSnapshotPattern.MatchString(r.Snapshot) {
		return fmt.Errorf("invalid snapshot")
	}
	if !filepath.IsAbs(r.Path) || strings.ContainsAny(r.Path, "\x00\r\n") || !filepath.IsAbs(r.Target) || strings.ContainsAny(r.Target, "\x00\r\n") {
		return fmt.Errorf("invalid restore path")
	}
	return nil
}

func planRestore(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Repository       string `json:"repository"`
		Snapshot         string `json:"snapshot"`
		Path             string `json:"path"`
		Target           string `json:"target"`
		ConfirmOverwrite bool   `json:"confirmOverwrite"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, invalid("Invalid request")
	}
	// Checked before any restic call: a value starting with "-" would be read as a flag.
	if !backupIDPattern.MatchString(req.Repository) {
		return nil, invalid("Invalid repository")
	}
	if !backupSnapshotPattern.MatchString(req.Snapshot) {
		return nil, invalid("Invalid snapshot")
	}
	path, err := cleanBackupPath(req.Path)
	if err != nil {
		return nil, invalid("Invalid path")
	}
	if req.Target != "new" && req.Target != "original" {
		return nil, invalid("Invalid restore target")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	repo, ok := cfg.repository(req.Repository)
	if !ok {
		return nil, &fsError{Code: "ENOENT", Message: "This repository does not exist"}
	}
	sec, err := readRepoSecrets(repo.ID)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: "The repository secrets are missing"}
	}
	snaps, err := resticSnapshots(repo, sec)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	var snapTime *time.Time
	for _, s := range snaps {
		if strings.HasPrefix(s.ID, req.Snapshot) {
			t := s.Time.Local()
			snapTime = &t
			break
		}
	}

	target, date := "/", req.Snapshot
	if snapTime != nil {
		date = snapTime.Format("2006-01-02 15:04")
	}
	if req.Target == "new" {
		if snapTime == nil {
			return nil, &fsError{Code: "ENOENT", Message: "This snapshot does not exist"}
		}
		base := volumeMountFor(path)
		if base == "" {
			base = filepath.Dir(path)
		}
		name := unsafeNameChars.ReplaceAllString(repo.Name, "-") + "-" + snapTime.Format("2006-01-02-1504")
		target = filepath.Join(base, "Restored", name)
	}

	sum, err := resticRestore(repo, sec, req.Snapshot, path, target, true, nil)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	if req.Target == "original" && sum.FilesRestored > 0 && !req.ConfirmOverwrite {
		return nil, &fsError{Code: "ECONFIRM", Message: fmt.Sprintf("This replaces %d files at their original location", sum.FilesRestored)}
	}

	p := &opPlan{Op: "backup.restore", Reply: map[string]any{}}
	rr := restoreRequest{Repository: repo.ID, Snapshot: req.Snapshot, Path: path, Target: target}
	p.Steps = []planStep{{Kind: "run", Target: target,
		Summary:     fmt.Sprintf("Restore %s from %s to %s (%d files)", path, date, target, sum.FilesRestored),
		Destructive: req.Target == "original",
		run: func() (string, error) {
			rr.RunID = newRunID()
			file, err := writeRestoreRequest(rr)
			if err != nil {
				return "", err
			}
			// Visible as running before the unit has started.
			_ = writeProgress(rr.RunID, backupProgress{})
			exe, err := os.Executable()
			if err != nil {
				return "", err
			}
			argv := []string{"systemd-run", "--unit", unitPrefix() + "-restore-" + rr.RunID, "--collect", exe, "backup", "restore", file}
			if out, err := runArgv(argv); err != nil {
				clearProgress(rr.RunID)
				os.Remove(file)
				return "", cmdError{cmdErrMessage(out, err)}
			}
			p.Reply["runId"] = rr.RunID
			return "", nil
		}}}
	return p, nil
}

func writeRestoreRequest(r restoreRequest) (string, error) {
	dir := filepath.Join(backupStateDir(), "restores")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	file := filepath.Join(dir, r.RunID+".json")
	return file, writeBackupFile(file, raw, 0o600)
}

// runRestoreRequest is `hsi-worker backup restore <file>`, started by the restore plan
// as a transient unit. Progress is kept under the run id, the result is logged under
// the repository id.
func runRestoreRequest(file string) error {
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var rr restoreRequest
	if err := json.Unmarshal(raw, &rr); err != nil {
		return fmt.Errorf("invalid restore request: %w", err)
	}
	if err := rr.validate(); err != nil {
		return err
	}
	defer os.Remove(file)
	defer clearProgress(rr.RunID)

	cfg, _, err := loadBackupConfig()
	if err != nil {
		return err
	}
	repo, ok := cfg.repository(rr.Repository)
	if !ok {
		return fmt.Errorf("unknown repository")
	}
	rec := runRecord{Start: time.Now()}
	_ = writeProgress(rr.RunID, backupProgress{})
	runErr := withLock(repo.ID, lockWait, func() error {
		sec, err := readRepoSecrets(repo.ID)
		if err != nil {
			return err
		}
		sum, err := resticRestore(repo, sec, rr.Snapshot, rr.Path, rr.Target, false, func(p backupProgress) {
			_ = writeProgress(rr.RunID, p)
		})
		rec.Files = sum.FilesRestored
		rec.Warnings = sum.Warnings
		return err
	})
	end := time.Now()
	rec.End = &end
	rec.Status = "success"
	if runErr != nil {
		rec.Status, rec.Error = "failed", runErr.Error()
	}
	if err := appendRun("restores", repo.ID, rec); err != nil {
		logger.Warn("restore run log not written", "id", repo.ID, "error", err.Error())
	}
	return runErr
}
