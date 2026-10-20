package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

var composeAction = runCompose

var composeRunning = func(app string) bool {
	full, err := composeArgs(app, "ps", "--status", "running", "-q")
	if err != nil {
		return false
	}
	out, err := exec.Command("docker", full...).Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// volumeAvailable is nil when the managed volume holding path is healthy, or when
// path is on no managed volume.
var volumeAvailable = func(path string) error {
	vols, err := volumeStatuses()
	if err != nil {
		return err
	}
	best := -1
	for i, v := range vols {
		mp := v.MountPoint
		if (path == mp || strings.HasPrefix(path, mp+"/")) && (best < 0 || len(mp) > len(vols[best].MountPoint)) {
			best = i
		}
	}
	if best >= 0 && vols[best].State != "ok" {
		return fmt.Errorf("%s: %s", vols[best].MountPoint, vols[best].State)
	}
	return nil
}

// backupLocalPaths are the paths of a sync plan that live on this machine.
func backupLocalPaths(o syncOptions) []string {
	switch {
	case o.RemoteHost == "":
		return []string{o.Source, o.Destination}
	case o.Direction == "pull":
		return []string{o.Destination}
	}
	return []string{o.Source}
}

func boolPtr(b bool) *bool { return &b }

// finishRun stamps the end time, appends the record and drops the progress file.
func finishRun(kind, id string, rec runRecord, now func() time.Time, runErr error) error {
	end := now()
	rec.End = &end
	if runErr != nil {
		rec.Status = "failed"
		rec.Error = runErr.Error()
	} else {
		rec.Status = "success"
	}
	if err := appendRun(kind, id, rec); err != nil {
		logger.Warn("backup run log not written", "id", id, "error", err.Error())
	}
	clearProgress(id)
	return runErr
}

func runPlan(id string, now func() time.Time) error {
	cfg, _, err := loadBackupConfig()
	if err != nil {
		return err
	}
	plan, ok := cfg.plan(id)
	if !ok {
		return fmt.Errorf("unknown backup plan")
	}
	if !plan.Enabled {
		return fmt.Errorf("backup plan is disabled")
	}
	rec := runRecord{Start: now()}
	switch plan.Type {
	case "versions":
		repo, ok := cfg.repository(plan.Versions.Repository)
		if !ok {
			return finishRun("runs", id, rec, now, fmt.Errorf("unknown repository"))
		}
		runErr := withLock(repo.ID, lockWait, func() error {
			return runVersions(plan, repo, &rec)
		})
		return finishRun("runs", id, rec, now, runErr)
	case "sync":
		runErr := withLock(id, lockWait, func() error {
			_ = writeProgress(id, backupProgress{})
			for _, p := range backupLocalPaths(*plan.Sync) {
				if err := volumeAvailable(p); err != nil {
					return err
				}
			}
			_, err := runRsync(syncTask(*plan.Sync))
			return err
		})
		return finishRun("runs", id, rec, now, runErr)
	}
	return fmt.Errorf("invalid plan type")
}

func syncTask(o syncOptions) taskMsg {
	return taskMsg{Source: o.Source, Destination: o.Destination, Direction: o.Direction,
		RemoteHost: o.RemoteHost, RemoteUser: o.RemoteUser, RemotePort: o.RemotePort, SSHKeyPath: o.SSHKeyPath,
		DeleteExtra: o.DeleteExtra, Compress: o.Compress, BandwidthLimit: o.BandwidthLimit, Excludes: o.Excludes}
}

// runVersions takes the snapshot with the plan's apps stopped, and always starts
// them again. It fills rec; the caller stamps the end and writes it.
func runVersions(plan backupPlanCfg, repo repositoryCfg, rec *runRecord) error {
	_ = writeProgress(plan.ID, backupProgress{})
	o := plan.Versions
	for _, src := range o.Sources {
		if err := volumeAvailable(src); err != nil {
			return err
		}
	}
	sec, err := readRepoSecrets(repo.ID)
	if err != nil {
		return err
	}

	consistent := true
	var stopped []string
	for _, app := range o.StopApps {
		if !composeRunning(app) {
			continue
		}
		// A failed stop can leave a multi-container app half stopped, so it is
		// started again too (starting running containers is harmless).
		stopped = append(stopped, app)
		if err := composeAction(app, "stop"); err != nil {
			consistent = false
			rec.Warnings = append(rec.Warnings, fmt.Sprintf("%s could not be stopped: %v", app, err))
		}
	}
	rec.Consistent = boolPtr(consistent)

	restarted := false
	restart := func() error {
		if restarted {
			return nil
		}
		restarted = true
		var failed []string
		for _, app := range stopped {
			if serr := composeAction(app, "start"); serr != nil {
				failed = append(failed, fmt.Sprintf("%s did not start again: %v", app, serr))
			}
		}
		if len(failed) > 0 {
			return errors.New(strings.Join(failed, "; "))
		}
		return nil
	}
	// Safety net for a panic; the normal path restarts right after the snapshot.
	defer restart()

	tag := "consistent"
	if !consistent {
		tag = "inconsistent"
	}
	sum, berr := resticBackup(repo, sec, o.Sources, o.Excludes, []string{"hsi", "plan:" + plan.ID, tag}, func(p backupProgress) {
		_ = writeProgress(plan.ID, p)
	})
	// The apps are back before the (possibly long) prune, whatever the snapshot did.
	rerr := restart()
	if berr == nil {
		rec.SnapshotID = sum.SnapshotID
		rec.Added = sum.DataAdded
		rec.Files = sum.FilesNew + sum.FilesChanged
		if sum.Partial && sum.Warning != "" {
			rec.Warnings = append(rec.Warnings, sum.Warning)
		}
		if ferr := resticForget(repo, sec, plan.ID, o.Retention); ferr != nil {
			rec.Warnings = append(rec.Warnings, "old snapshots were not pruned: "+ferr.Error())
		}
	}
	switch {
	case berr != nil && rerr != nil:
		return fmt.Errorf("%w; %v", berr, rerr)
	case berr != nil:
		return berr
	}
	return rerr
}

func runCheck(repoID string, full bool, now func() time.Time) error {
	cfg, _, err := loadBackupConfig()
	if err != nil {
		return err
	}
	repo, ok := cfg.repository(repoID)
	if !ok {
		return fmt.Errorf("unknown repository")
	}
	rec := runRecord{Start: now()}
	runErr := withLock(repoID, lockWait, func() error {
		sec, err := readRepoSecrets(repoID)
		if err != nil {
			return err
		}
		subset := repo.Check.Subset
		if full {
			subset = ""
		}
		return resticCheck(repo, sec, subset)
	})
	return finishRun("checks", repoID, rec, now, runErr)
}

// runBackupCLI is `hsi-worker backup run|check|restore`, called by the hsi-backup@
// units without NATS or the backend.
func runBackupCLI(args []string) int {
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, err.Error())
		logger.Warn("backup command failed", "error", err.Error())
		return 1
	}
	if len(args) < 2 {
		return fail(fmt.Errorf("usage: backup run <planId> | check <repoId> [--full] | restore <requestFile>"))
	}
	switch args[0] {
	case "run":
		if !backupIDPattern.MatchString(args[1]) {
			return fail(fmt.Errorf("invalid plan id"))
		}
		if err := runPlan(args[1], time.Now); err != nil {
			return fail(err)
		}
		return 0
	case "check":
		fs := flag.NewFlagSet("check", flag.ContinueOnError)
		full := fs.Bool("full", false, "read all data")
		if err := fs.Parse(args[2:]); err != nil {
			return fail(err)
		}
		if !backupIDPattern.MatchString(args[1]) {
			return fail(fmt.Errorf("invalid repository id"))
		}
		if err := runCheck(args[1], *full, time.Now); err != nil {
			return fail(err)
		}
		return 0
	case "restore":
		return fail(fmt.Errorf("backup restore is not implemented yet"))
	}
	return fail(fmt.Errorf("unknown backup command %q", args[0]))
}
