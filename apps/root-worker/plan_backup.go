package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Plan builders: backup plans, repositories and restores (#15) ────────────

var backupSnapshotPattern = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

// planInvalid is the refusal of a plan built from invalid input.
func planInvalid(msg string) *fsError { return &fsError{Code: "EINVALID", Message: msg} }

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
		return nil, planInvalid("Invalid request")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	next := withPlan(cfg, req.Plan)
	if err := next.validate(); err != nil {
		return nil, planInvalid(err.Error())
	}
	if v := req.Plan.Versions; v != nil {
		for _, app := range v.StopApps {
			if !fileExists(filepath.Join(containersDir, app, "compose.yaml")) {
				return nil, planInvalid("The app " + app + " does not exist")
			}
		}
		repo, _ := next.repository(v.Repository)
		for _, src := range v.Sources {
			if clean, _ := cleanBackupPath(src); volumeMountFor(clean) == "" {
				return nil, planInvalid("The source " + clean + " is not on a data volume")
			}
		}
		if fe := sourcesApartFromRepository(req.Plan, repo); fe != nil {
			return nil, fe
		}
	}
	steps := []planStep{backupConfigStep("Save the backup plan "+req.Plan.Name, next)}
	steps = append(steps, writeTimerSteps(filepath.Join(systemdDir(), planTimerName(req.Plan.ID)), planTimerUnit(req.Plan))...)
	return &opPlan{Op: "backup.plan.save", Observed: backupObserved(), Steps: steps}, nil
}

// sourcesApartFromRepository refuses a versions plan whose local repository is inside
// one of its sources, or the other way round: the repository would back itself up.
func sourcesApartFromRepository(p backupPlanCfg, repo repositoryCfg) *fsError {
	if p.Versions == nil || repo.Type != "local" {
		return nil
	}
	dest := filepath.Clean(repo.Path)
	for _, src := range p.Versions.Sources {
		clean := filepath.Clean(src)
		if strings.HasPrefix(dest+"/", clean+"/") || strings.HasPrefix(clean+"/", dest+"/") {
			return planInvalid("The source " + clean + " and the repository " + repo.Name + " overlap")
		}
	}
	return nil
}

func planBackupPlanRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !backupIDPattern.MatchString(req.ID) {
		return nil, planInvalid("Invalid backup plan")
	}
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	plan, ok := cfg.plan(req.ID)
	if !ok {
		return nil, &fsError{Code: "ENOENT", Message: "This backup plan does not exist"}
	}
	if runActive(req.ID) {
		return nil, &fsError{Code: "EBUSY", Message: "This backup plan is running"}
	}
	steps := writeTimerSteps(filepath.Join(systemdDir(), planTimerName(req.ID)), "")
	steps = append(steps, backupConfigStep("Remove the backup plan "+plan.Name+" (its run history is kept)", withoutPlan(cfg, req.ID)))
	return &opPlan{Op: "backup.plan.remove", Observed: backupObserved(), Steps: steps}, nil
}

// mergeSecrets keeps the stored value of every blank field. The password is the
// stored one too, whatever was given, unless the location changes: only then can a
// given password be the one that opens the repository found there.
func mergeSecrets(stored, given repoSecrets, locationChanged bool) repoSecrets {
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
	if stored.Password != "" && !locationChanged {
		out.Password = stored.Password
	}
	return out
}

// validateRepoSecrets is the check applied to secrets from a request and from an archive.
func validateRepoSecrets(r repositoryCfg, s repoSecrets) error {
	for _, v := range []string{s.Password, s.SSHKeyPath, s.AccessKeyID, s.SecretAccessKey, s.RestUser, s.RestPassword} {
		if strings.ContainsAny(v, "\x00\r\n") {
			return fmt.Errorf("invalid credential")
		}
	}
	if r.Type == "sftp" || s.SSHKeyPath != "" {
		if err := validSSHKeyPath(s.SSHKeyPath); err != nil {
			return fmt.Errorf("a valid SSH key path is required")
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
		return nil, planInvalid("Invalid request")
	}
	repo := req.Repository
	cfg, fe := loadBackupConfigFsErr()
	if fe != nil {
		return nil, fe
	}
	next := withRepository(cfg, repo)
	if err := next.validate(); err != nil {
		return nil, planInvalid(err.Error())
	}
	old, exists := cfg.repository(repo.ID)
	location := resticRepository(repo)
	locationChanged := !exists || resticRepository(old) != location
	// Read even for a new repository: an apply that failed after the init left the
	// secrets of this id, and a retry attaches with them.
	stored, _ := readRepoSecrets(repo.ID)
	sec := mergeSecrets(stored, req.Secrets, locationChanged)
	if err := validateRepoSecrets(repo, sec); err != nil {
		return nil, planInvalid(err.Error())
	}
	if repo.Type == "local" {
		if err := checkLocalRepoPath(repo.Path); err != nil {
			return nil, planInvalid(err.Error())
		}
	}
	for _, pl := range next.Plans {
		if pl.Versions != nil && pl.Versions.Repository == repo.ID {
			if fe := sourcesApartFromRepository(pl, repo); fe != nil {
				return nil, fe
			}
		}
	}

	p := &opPlan{Op: "backup.repository.save", Reply: map[string]any{}}
	generate := false
	if locationChanged {
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
		case state != probeEmpty && sec.Password == "", state == probeWrongPassword && req.Secrets.Password == "":
			// Nothing was typed: ask for the password of the repository found there.
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
					// A missing local folder is created by the init, see resticCmdFiles.
					if err := resticInit(repo, sec); err != nil {
						return "", err
					}
					// Stored at once: a later failure must not lose a password that only exists now.
					if err := writeRepoSecrets(repo.ID, sec); err != nil {
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
		return nil, planInvalid("Invalid repository")
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
	if repositoryBusy(req.ID) {
		return nil, &fsError{Code: "EBUSY", Message: "A check or a restore is using this repository"}
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
var volumeMountFor = func(path string) string {
	vols, err := volumeStatesNow()
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
	Mode       string `json:"mode"` // new | original
	Base       string `json:"base"` // new: the volume mount point (or the parent of path) holding Restored/
	Name       string `json:"name"` // new: name of the directory created under Restored/
}

func (r restoreRequest) validate() error {
	if !backupIDPattern.MatchString(r.RunID) || !backupIDPattern.MatchString(r.Repository) {
		return fmt.Errorf("invalid restore request")
	}
	if !backupSnapshotPattern.MatchString(r.Snapshot) {
		return fmt.Errorf("invalid snapshot")
	}
	if !filepath.IsAbs(r.Path) || strings.ContainsAny(r.Path, "\x00\r\n") {
		return fmt.Errorf("invalid restore path")
	}
	if !filepath.IsAbs(r.Base) || strings.ContainsAny(r.Base, "\x00\r\n") {
		return fmt.Errorf("invalid restore target")
	}
	switch r.Mode {
	case "original":
	case "new":
		if r.Name == "" || r.Name != filepath.Base(r.Name) || r.Name == "." || r.Name == ".." {
			return fmt.Errorf("invalid restore target")
		}
	default:
		return fmt.Errorf("invalid restore target")
	}
	return nil
}

// filesCount is "1 file" or "N files".
func filesCount(n int) string {
	if n == 1 {
		return "1 file"
	}
	return fmt.Sprintf("%d files", n)
}

func overwriteMessage(n int) string {
	if n == 1 {
		return "This replaces 1 file at its original location"
	}
	return fmt.Sprintf("This replaces %d files at their original location", n)
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
		return nil, planInvalid("Invalid request")
	}
	// Checked before any restic call: a value starting with "-" would be read as a flag.
	if !backupIDPattern.MatchString(req.Repository) {
		return nil, planInvalid("Invalid repository")
	}
	if !backupSnapshotPattern.MatchString(req.Snapshot) {
		return nil, planInvalid("Invalid snapshot")
	}
	path, err := cleanBackupPath(req.Path)
	if err != nil {
		return nil, planInvalid("Invalid path")
	}
	if req.Target != "new" && req.Target != "original" {
		return nil, planInvalid("Invalid restore target")
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
	if err := repositoryReady(repo); err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
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

	// base holds the new directory, or the staging directory of a restore to the original
	// location (it must be on the same filesystem as the restored path).
	base := volumeMountFor(path)
	if base == "" {
		if req.Target == "original" {
			// Staging would put a root-owned Restored folder next to the path, in a
			// folder HSI does not manage (a home folder, say).
			return nil, planInvalid("Only a path on a data volume can be restored to its original location: restore it to a new folder")
		}
		base = filepath.Dir(path)
	}
	target, date, name := "/", req.Snapshot, ""
	if snapTime != nil {
		date = snapTime.Format("2006-01-02 15:04")
	}
	if req.Target == "new" {
		if snapTime == nil {
			return nil, &fsError{Code: "ENOENT", Message: "This snapshot does not exist"}
		}
		name = unsafeNameChars.ReplaceAllString(repo.Name, "-") + "-" + snapTime.Format("2006-01-02-1504")
		target = filepath.Join(base, "Restored", name)
	}

	if _, err := resticRestore(repo, sec, req.Snapshot, path, target, true, nil); err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	// restic's counters (total_files, files_restored) include the folders.
	files, err := resticCountFiles(repo, sec, req.Snapshot, path)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	if files == 0 {
		return nil, &fsError{Code: "ENOENT", Message: "Nothing to restore: the snapshot holds no file at " + path}
	}
	if req.Target == "original" && !req.ConfirmOverwrite {
		return nil, &fsError{Code: "ECONFIRM", Message: overwriteMessage(files)}
	}

	p := &opPlan{Op: "backup.restore", Reply: map[string]any{}}
	rr := restoreRequest{Repository: repo.ID, Snapshot: req.Snapshot, Path: path, Mode: req.Target, Base: base, Name: name}
	p.Steps = []planStep{{Kind: "run", Target: target,
		Summary:     fmt.Sprintf("Restore %s from %s to %s (%s)", path, date, target, filesCount(files)),
		Destructive: req.Target == "original",
		run: func() (string, error) {
			rr.RunID = newRunID()
			file, err := writeRestoreRequest(rr)
			if err != nil {
				return "", err
			}
			// Until the unit holds its run lock, the request file shows the restore as queued.
			exe, err := os.Executable()
			if err != nil {
				return "", err
			}
			argv := append([]string{"systemd-run", "--unit", unitPrefix() + "-restore-" + rr.RunID, "--collect"}, backupUnitProps()...)
			argv = append(argv, hsiEnvArgs(os.Environ())...)
			argv = append(argv, exe, "backup", "restore", file)
			if out, err := runArgv(argv); err != nil {
				os.Remove(file)
				return "", cmdError{cmdErrMessage(out, err)}
			}
			p.Reply["runId"] = rr.RunID
			return "", nil
		}}}
	return p, nil
}

// hsiEnvArgs forwards the worker's HSI_* paths to the restore unit, so it reads the
// same configuration the plan was built from. Variables that look like credentials stay out
// of the unit's command line.
func hsiEnvArgs(environ []string) []string {
	var out []string
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		up := strings.ToUpper(k)
		if !strings.HasPrefix(k, "HSI_") || strings.ContainsAny(kv, "\x00\r\n") {
			continue
		}
		// HSI_BACKUP_SECRETS names the secrets folder, it holds no secret itself.
		credential := strings.Contains(up, "TOKEN") || strings.Contains(up, "SECRET") || strings.Contains(up, "PASSWORD") || strings.Contains(up, "KEY")
		if credential && k != "HSI_BACKUP_SECRETS" {
			continue
		}
		out = append(out, "--setenv="+kv)
	}
	sort.Strings(out)
	return out
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
// the repository id (a failed one too, as soon as that id is known).
func runRestoreRequest(file string) error {
	var rr restoreRequest
	release := func() {}
	// Whatever happens next, a progress entry for this run is never left "running", and
	// the run lock goes last so that no status read sees the run neither queued nor running.
	defer func() {
		if backupIDPattern.MatchString(rr.RunID) {
			clearProgress(rr.RunID)
		}
		os.Remove(file)
		release()
	}()
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	rec := runRecord{Start: time.Now()}
	finish := func(err error) error {
		err = asInterrupted(err)
		if !backupIDPattern.MatchString(rr.Repository) {
			return err
		}
		end := time.Now()
		rec.End = &end
		rec.RunID = rr.RunID
		rec.Status = "success"
		if err != nil {
			rec.Status, rec.Error = "failed", err.Error()
		}
		if lerr := appendRun("restores", rr.Repository, rec); lerr != nil {
			logger.Warn("restore run log not written", "id", rr.Repository, "error", lerr.Error())
		}
		return err
	}
	if err := json.Unmarshal(raw, &rr); err != nil {
		return finish(fmt.Errorf("invalid restore request: %w", err))
	}
	if err := rr.validate(); err != nil {
		return finish(err)
	}
	if release, err = holdRunLock(rr.RunID); err != nil {
		release = func() {}
		return finish(err)
	}

	cfg, _, err := loadBackupConfig()
	if err != nil {
		return finish(err)
	}
	repo, ok := cfg.repository(rr.Repository)
	if !ok {
		return finish(fmt.Errorf("unknown repository"))
	}
	_ = writeProgress(rr.RunID, backupProgress{})
	return finish(withLock(repo.ID, lockWait, func() error {
		if err := repositoryReady(repo); err != nil {
			return err
		}
		sec, err := readRepoSecrets(repo.ID)
		if err != nil {
			return err
		}
		return restoreHeld(rr, repo, sec, &rec)
	}))
}

// restoreHeld restores into directories held by descriptor, see restore_fd.go.
func restoreHeld(rr restoreRequest, repo repositoryCfg, sec repoSecrets, rec *runRecord) error {
	progress := func(p backupProgress) { _ = writeProgress(rr.RunID, p) }
	base, err := openDirNoFollow(rr.Base)
	if err != nil {
		return err
	}
	defer base.Close()

	if rr.Mode == "new" {
		restored, err := openRestoredDir(base)
		if err != nil {
			return err
		}
		defer restored.Close()
		final, created, err := createFreshDir(restored, rr.Name, true)
		if err != nil {
			return err
		}
		rec.Target = filepath.Join(rr.Base, "Restored", created)
		defer final.Close()
		sum, err := resticRestoreAt(repo, sec, rr.Snapshot, rr.Path, "", final, false, progress)
		rec.Warnings = sum.Warnings
		if err != nil {
			// A failed restore leaves no empty folder behind. Only root can change the
			// entries of Restored, and rmdir removes nothing that holds a file.
			if unlinkat(restored, created, atRemoveDir) == nil {
				rec.Target = ""
			}
			return err
		}
		// Counted on the folder restic wrote: its counters include the folders.
		if rec.Files, err = countFiles(final); err != nil {
			return err
		}
		return final.Chmod(0o755)
	}

	rec.Target = rr.Path
	// Original location: restore into a staging directory first, then move the files
	// into place. Staging lives in Restored, where only root can rename or replace
	// entries, so creating, using and removing it cannot be redirected.
	restored, err := openRestoredDir(base)
	if err != nil {
		return err
	}
	defer restored.Close()
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	stageName := fmt.Sprintf(".staging-%s-%x", rr.RunID, suffix)
	stage, _, err := createFreshDir(restored, stageName, false)
	if err != nil {
		return err
	}
	defer func() {
		if err := removeChildren(stage); err == nil {
			_ = unlinkat(restored, stageName, atRemoveDir)
		}
		stage.Close()
	}()
	sum, err := resticRestoreAt(repo, sec, rr.Snapshot, rr.Path, "", stage, false, progress)
	rec.Warnings = sum.Warnings
	if err != nil {
		return err
	}

	// The staged tree holds the absolute paths, from the volume mount point (or "/").
	root := "/"
	if mount := volumeMountFor(rr.Path); mount != "" {
		root = mount
	}
	src, err := descendDirs(stage, root)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := openDirNoFollow(root)
	if err != nil {
		return err
	}
	defer dst.Close()
	var res mergeResult
	err = mergeInto(src, dst, "", &res)
	rec.Files = res.moved
	rec.Warnings = append(rec.Warnings, res.warnings...)
	return err
}
