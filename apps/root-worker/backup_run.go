package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// composeAction runs docker compose for an app within ctx. Its context is never the
// interruption's: an app being started again must not be cancelled by the signal
// that stops the run.
var composeAction = func(ctx context.Context, app string, args ...string) error {
	full, err := composeArgs(app, args...)
	if err != nil {
		return err
	}
	out, err := commandContext(ctx, "docker", full...).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return errors.New(msg)
		}
		return err
	}
	return nil
}

// Bounds of the compose calls of a run. A stop is cut short by an interruption and the
// restart stays below TimeoutStopSec (120 s), so an interrupted run still starts its
// apps and records itself before systemd kills it.
var (
	appStopTimeout    = 60 * time.Second
	appRestartTimeout = 90 * time.Second
)

// composeRunning tells whether the app has a running container. An error means the
// state is unknown: the app is then left alone and the snapshot is not consistent.
var composeRunning = func(app string) (bool, error) {
	full, err := composeArgs(app, "ps", "--status", "running", "-q")
	if err != nil {
		return false, err
	}
	out, err := command("docker", full...).Output()
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) != "", nil
}

// volumeAvailable is nil when the managed volume holding path is healthy, or when
// path is on no managed volume. It never remounts anything (see volumeStatesNow).
var volumeAvailable = func(path string) error {
	vols, err := volumeStatesNow()
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

// ── Interruption ────────────────────────────────────────────────────────────
// systemd stops a backup unit with SIGTERM (a shutdown, or the admin). The run must
// still start the apps it stopped and record itself, so the signal only interrupts
// the restic child and the run winds down.

var errInterrupted = errors.New("interrupted")

var interrupted atomic.Bool

// interruptedCh is closed at the interruption, for the waits it must cut short.
var (
	interruptMu   sync.Mutex
	interruptedCh = make(chan struct{})
)

// untilInterrupted is a context that ends after d, or at once when the run is
// interrupted: for an app stop, which must not use up the unit's stop timeout.
func untilInterrupted(d time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	interruptMu.Lock()
	ch := interruptedCh
	interruptMu.Unlock()
	go func() {
		select {
		case <-ch:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

var (
	childMu  sync.Mutex
	children = map[*os.Process]bool{}
)

// trackChild lets an interruption reach a started child; call the result once it exited.
func trackChild(p *os.Process) func() {
	childMu.Lock()
	children[p] = true
	childMu.Unlock()
	if interrupted.Load() {
		_ = p.Signal(syscall.SIGTERM)
	}
	return func() {
		childMu.Lock()
		delete(children, p)
		childMu.Unlock()
	}
}

// interruptRun marks the run interrupted and passes sig on to every running child.
func interruptRun(sig os.Signal) {
	interruptMu.Lock()
	if !interrupted.Swap(true) {
		close(interruptedCh)
	}
	interruptMu.Unlock()
	childMu.Lock()
	defer childMu.Unlock()
	for p := range children {
		_ = p.Signal(sig)
	}
}

// catchInterrupts turns SIGTERM and SIGINT into interruptRun until stop is called.
func catchInterrupts() (stop func()) {
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case sig := <-ch:
				logger.Warn("backup command interrupted", "signal", sig.String())
				interruptRun(sig)
			case <-done:
				return
			}
		}
	}()
	return func() { signal.Stop(ch); close(done) }
}

// asInterrupted reports a failed run of an interrupted command as interrupted: restic's
// own message about the signal says less.
func asInterrupted(err error) error {
	if err != nil && interrupted.Load() && !errors.Is(err, errInterrupted) {
		return errInterrupted
	}
	return err
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
	runErr = asInterrupted(runErr)
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

// runPlan runs a backup plan. A paused plan only runs when started by hand (manual):
// its timer is removed, so a timer run of one is a leftover and records nothing.
func runPlan(id string, manual bool, now func() time.Time) error {
	release, err := holdRunLock(id)
	if err != nil {
		// Another run of this plan is going on, and it writes its own record.
		return err
	}
	defer release()
	rec := runRecord{Start: now()}
	cfg, _, err := loadBackupConfig()
	if err != nil {
		return finishRun("runs", id, rec, now, err)
	}
	plan, ok := cfg.plan(id)
	if !ok {
		return finishRun("runs", id, rec, now, fmt.Errorf("unknown backup plan"))
	}
	if !plan.Enabled && !manual {
		return fmt.Errorf("backup plan is paused")
	}
	// Visible as running while the run waits for its repository.
	_ = writeProgress(id, backupProgress{})
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
		// The run lock already keeps a second run of this plan out.
		var runErr error
		for _, p := range backupLocalPaths(*plan.Sync) {
			if runErr = volumeAvailable(p); runErr != nil {
				break
			}
		}
		if runErr == nil {
			_, runErr = runRsync(syncTask(*plan.Sync))
		}
		return finishRun("runs", id, rec, now, runErr)
	}
	return finishRun("runs", id, rec, now, fmt.Errorf("invalid plan type"))
}

func syncTask(o syncOptions) taskMsg {
	return taskMsg{Source: o.Source, Destination: o.Destination, Direction: o.Direction,
		RemoteHost: o.RemoteHost, RemoteUser: o.RemoteUser, RemotePort: o.RemotePort, SSHKeyPath: o.SSHKeyPath,
		DeleteExtra: o.DeleteExtra, Compress: o.Compress, BandwidthLimit: o.BandwidthLimit, Excludes: o.Excludes}
}

// runVersions takes the snapshot with the plan's apps stopped, and always starts
// them again. It fills rec; the caller stamps the end and writes it.
func runVersions(plan backupPlanCfg, repo repositoryCfg, rec *runRecord) error {
	o := plan.Versions
	for _, src := range o.Sources {
		if err := volumeAvailable(src); err != nil {
			return err
		}
	}
	if err := repositoryReady(repo); err != nil {
		return err
	}
	sec, err := readRepoSecrets(repo.ID)
	if err != nil {
		return err
	}

	consistent := true
	var stopped []string
	for _, app := range o.StopApps {
		if interrupted.Load() {
			// No more stops: the run winds down and starts what it stopped.
			break
		}
		running, err := composeRunning(app)
		if err != nil {
			consistent = false
			rec.Warnings = append(rec.Warnings, fmt.Sprintf("could not tell whether %s is running: %v", app, err))
			continue
		}
		if !running {
			continue
		}
		// A failed stop can leave a multi-container app half stopped, so it is
		// started again too (starting running containers is harmless).
		stopped = append(stopped, app)
		ctx, cancel := untilInterrupted(appStopTimeout)
		err = composeAction(ctx, app, "stop")
		cancel()
		if err != nil {
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
		ctx, cancel := context.WithTimeout(context.Background(), appRestartTimeout)
		defer cancel()
		var failed []string
		for _, app := range stopped {
			if serr := composeAction(ctx, app, "start"); serr != nil {
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
	var sum backupSummary
	berr := errInterrupted
	if !interrupted.Load() {
		sum, berr = resticBackup(repo, sec, o.Sources, o.Excludes, []string{"hsi", "plan:" + plan.ID, tag}, func(p backupProgress) {
			_ = writeProgress(plan.ID, p)
		})
	}
	// The apps are back before the (possibly long) prune, whatever the snapshot did.
	rerr := restart()
	if berr == nil {
		rec.SnapshotID = sum.SnapshotID
		rec.Added = sum.DataAdded
		rec.Files = sum.FilesNew + sum.FilesChanged
		if sum.Partial && sum.Warning != "" {
			rec.Warnings = append(rec.Warnings, sum.Warning)
		}
		if interrupted.Load() {
			rec.Warnings = append(rec.Warnings, "old snapshots were not pruned: interrupted")
		} else if ferr := resticForget(repo, sec, plan.ID, o.Retention); ferr != nil {
			rec.Warnings = append(rec.Warnings, "old snapshots were not pruned: "+ferr.Error())
		}
	}
	berr = asInterrupted(berr)
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
		if err := repositoryReady(repo); err != nil {
			return err
		}
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

const backupUsage = "usage: backup run <planId> [--manual] | check <repoId> [--full] | restore <requestFile>"

// runBackupCLI is `hsi-worker backup run|check|restore`, called by the hsi-backup@
// units without NATS or the backend.
func runBackupCLI(args []string) int {
	stop := catchInterrupts()
	defer stop()
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, err.Error())
		logger.Warn("backup command failed", "error", err.Error())
		return 1
	}
	if len(args) < 2 {
		return fail(errors.New(backupUsage))
	}
	switch args[0] {
	case "run":
		fs := flag.NewFlagSet("run", flag.ContinueOnError)
		manual := fs.Bool("manual", false, "run a paused plan too")
		if err := fs.Parse(args[2:]); err != nil {
			return fail(err)
		}
		if !backupIDPattern.MatchString(args[1]) || fs.NArg() > 0 {
			return fail(fmt.Errorf("invalid plan id"))
		}
		if err := runPlan(args[1], *manual, time.Now); err != nil {
			return fail(err)
		}
		return 0
	case "check":
		fs := flag.NewFlagSet("check", flag.ContinueOnError)
		full := fs.Bool("full", false, "read all data")
		if err := fs.Parse(args[2:]); err != nil {
			return fail(err)
		}
		if !backupIDPattern.MatchString(args[1]) || fs.NArg() > 0 {
			return fail(fmt.Errorf("invalid repository id"))
		}
		if err := runCheck(args[1], *full, time.Now); err != nil {
			return fail(err)
		}
		return 0
	case "restore":
		if len(args) != 2 {
			return fail(errors.New(backupUsage))
		}
		if err := runRestoreRequest(args[1]); err != nil {
			return fail(err)
		}
		return 0
	}
	return fail(fmt.Errorf("unknown backup command %q", args[0]))
}
