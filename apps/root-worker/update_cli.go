package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

// ── Safe updates (#9a): `hsi-worker update ...` ──────────────────────────────

const updateUsage = `usage: hsi-worker update <command>
  apply <version> [--archive <path>]      verify a release, then run its installer
  apply-pending                           apply the version the dashboard asked for (update-apply unit)
  snapshot <from> <to>                    snapshot the database and configuration, print its dir
  mark <from> <to> <snapshot> <step> [--pid N]   write the in-progress marker
  switch <version>                        point current at releases/<version>
  replace <version> <staged>              swap releases/<staged> in for releases/<version> (repair)
  health <version> [--timeout 120]        wait until that version is healthy
  commit <from> <to> <snapshot>           record success, prune old versions and snapshots
  repaired <version>                      record a reinstall of the current version, prune
  rollback [--snapshot <dir>] [--yes] [--reason <text>]   go back to the previous version
  status                                  last result, current and previous versions (JSON)`

// Swapped by tests.
var (
	updateStdin  io.Reader = os.Stdin
	updateStdout io.Writer = os.Stdout
)

// runInstaller runs a verified install.sh and returns its exit code.
var runInstaller = func(installer string, env []string) int {
	cmd := exec.Command("/bin/bash", installer)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "run the installer:", err)
		return 1
	}
	return 0
}

// Keep two previous versions and two snapshots.
const updateKeep = 2

// loadWorkerEnvDefaults takes the HSI_ settings of the worker env file that the
// environment does not set: an admin's `sudo hsi-worker update rollback` then uses
// the paths of a custom APP_NAME install like the units do.
func loadWorkerEnvDefaults() {
	for k, v := range readEnvFile(workerEnvPath()) {
		if !strings.HasPrefix(k, "HSI_") {
			continue
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}

func runUpdateCLI(args []string) int {
	loadWorkerEnvDefaults()
	fail := func(code int, err error) int {
		fmt.Fprintln(os.Stderr, err.Error())
		logger.Warn("update command failed", "error", err.Error())
		return code
	}
	if len(args) == 0 {
		return fail(2, errors.New(updateUsage))
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	archive := fs.String("archive", "", "")
	timeout := fs.Int("timeout", int(healthTimeout/time.Second), "")
	snapshot := fs.String("snapshot", "", "")
	yes := fs.Bool("yes", false, "")
	reason := fs.String("reason", "", "")
	pid := fs.Int("pid", os.Getppid(), "")
	// Positional arguments come first, flags after them.
	var pos []string
	rest := args[1:]
	for len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		pos, rest = append(pos, rest[0]), rest[1:]
	}
	if err := fs.Parse(rest); err != nil || fs.NArg() > 0 {
		return fail(2, errors.New(updateUsage))
	}
	want := map[string]int{"apply": 1, "snapshot": 2, "mark": 4, "switch": 1, "replace": 2, "health": 1, "commit": 3, "repaired": 1, "rollback": 0, "status": 0, "recover": 0, "apply-pending": 0}
	if n, ok := want[args[0]]; !ok || n != len(pos) {
		return fail(2, errors.New(updateUsage))
	}

	switch args[0] {
	case "apply":
		return updateApply(pos[0], *archive)
	case "apply-pending":
		return updateApplyPending()
	case "snapshot":
		dir, err := takeSnapshot(pos[0], pos[1], updateDBPath(), snapshotConfigFiles())
		if err != nil {
			return fail(1, err)
		}
		fmt.Fprintln(updateStdout, dir)
	case "mark":
		p := inProgress{From: pos[0], To: pos[1], Snapshot: pos[2], Step: pos[3], Started: time.Now().UTC(), PID: *pid}
		if err := checkInstalledVersion(p.From); err != nil {
			return fail(2, err)
		}
		if err := checkInstalledVersion(p.To); err != nil {
			return fail(2, err)
		}
		if old, _ := readInProgress(); old != nil && old.From == p.From && old.To == p.To {
			p.Started = old.Started
		}
		if err := writeInProgress(p); err != nil {
			return fail(1, err)
		}
	case "switch":
		if err := switchCurrent(pos[0]); err != nil {
			return fail(1, err)
		}
	case "replace":
		if err := replaceRelease(pos[0], pos[1]); err != nil {
			return fail(1, err)
		}
	case "health":
		t := healthTargetFor(pos[0])
		t.Timeout = time.Duration(*timeout) * time.Second
		if err := waitHealthy(t); err != nil {
			return fail(1, err)
		}
	case "commit":
		if err := checkCommit(pos[0], pos[1], pos[2]); err != nil {
			return fail(1, err)
		}
		if err := writeLast(lastResult{From: pos[0], To: pos[1], Status: "success"}); err != nil {
			return fail(1, err)
		}
		clearInProgress()
		pruneUpdateState()
	case "repaired":
		if err := checkInstalledVersion(pos[0]); err != nil {
			return fail(2, err)
		}
		if currentVersion() != pos[0] {
			return fail(1, fmt.Errorf("%s is not the current version (%s)", pos[0], currentVersion()))
		}
		if err := writeLast(lastResult{From: pos[0], To: pos[0], Status: "success", Step: "repair"}); err != nil {
			return fail(1, err)
		}
		pruneUpdateState()
	case "rollback":
		return updateRollbackCLI(*snapshot, *yes, *reason)
	case "status":
		b, _ := json.Marshal(updateStatus())
		fmt.Fprintln(updateStdout, string(b))
	case "recover":
		if err := recoverUpdate(); err != nil {
			return fail(1, err)
		}
	}
	return 0
}

// checkCommit refuses a commit that is not the update in progress.
func checkCommit(from, to, snapshot string) error {
	if err := checkInstalledVersion(from); err != nil {
		return err
	}
	if err := checkInstalledVersion(to); err != nil {
		return err
	}
	p, err := readInProgress()
	if err != nil {
		return err
	}
	if p == nil {
		return errors.New("no update is in progress")
	}
	if p.From != from || p.To != to || filepath.Clean(p.Snapshot) != filepath.Clean(snapshot) {
		return fmt.Errorf("the update in progress is %s -> %s (snapshot %s)", p.From, p.To, p.Snapshot)
	}
	return nil
}

// stagingMaxAge is when a leftover apply-* staging dir is removed.
const stagingMaxAge = 24 * time.Hour

// updateRollbackCLI is the manual rollback (confirmed by typing the previous version)
// and the scripted one (--yes). Both take the update lock, except when the installer,
// which holds it, sets HSI_UPDATE_LOCK_HELD=1.
func updateRollbackCLI(snapshotDir string, yes bool, reason string) int {
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	if snapshotDir == "" {
		s, ok := latestSnapshotFor(currentVersion())
		if !ok {
			return fail(fmt.Errorf("no snapshot to roll back to from %s", currentVersion()))
		}
		snapshotDir = s.Dir
	}
	m, err := readManifest(snapshotDir)
	if err != nil {
		return fail(err)
	}
	step := "manual"
	if p, _ := readInProgress(); p != nil && p.Snapshot == snapshotDir {
		step = p.Step
	}
	// The installer calling `rollback --yes` already holds the lock and says so.
	if !yes || os.Getenv("HSI_UPDATE_LOCK_HELD") != "1" {
		lock, free, err := tryUpdateLock()
		if err != nil {
			return fail(err)
		}
		if !free {
			return fail(errors.New("an update is running; wait for it to finish"))
		}
		defer lock.Close()
	}
	if !yes {
		fmt.Fprintf(updateStdout, "This goes back to %s with the database of %s.\n", m.From, snapshotAge(m.Created))
		fmt.Fprintln(updateStdout, "Everything changed since then (users, shares, settings, app changes) will be lost.")
		fmt.Fprintf(updateStdout, "Type %s to confirm: ", m.From)
		line, _ := bufio.NewReader(updateStdin).ReadString('\n')
		if strings.TrimSpace(line) != m.From {
			return fail(errors.New("not confirmed, nothing changed"))
		}
		if reason == "" {
			reason = "rolled back by the administrator"
		}
	}
	if reason == "" {
		reason = "the update failed"
	}
	if err := rollback(snapshotDir, step, reason); err != nil {
		return fail(err)
	}
	fmt.Fprintf(updateStdout, "Rolled back to %s.\n", m.From)
	return 0
}

// updateApply is the dashboard update: download (or copy) the release into a private
// staging dir, verify it, then run the verified install.sh, which extracts the archive
// after checking its layout. The worker does not extract it too: the signature is what
// makes the archive trusted (the installer that unpacks it is in the same signed set),
// and a second copy would double the disk an update needs. A refusal changes nothing
// but last.json.
func updateApply(version, archive string) int {
	from := currentVersion()
	refuse := func(step string, err error) int {
		fmt.Fprintln(os.Stderr, err.Error())
		logger.Error("update refused", "version", version, "step", step, "error", err.Error())
		_ = writeLast(lastResult{From: from, To: version, Status: "refused", Step: step, Reason: err.Error()})
		return 1
	}
	if checkReleaseVersion(version) != nil {
		// Never echoed: the request may hold anything.
		version = ""
		return refuse("verify", errInvalidVersionRequested)
	}
	if err := os.MkdirAll(updateStateDir(), 0o700); err != nil {
		return refuse("download", err)
	}
	pruneStaging(stagingMaxAge)
	stage, err := os.MkdirTemp(updateStateDir(), "apply-")
	if err != nil {
		return refuse("download", err)
	}
	defer os.RemoveAll(stage)
	dl := filepath.Join(stage, "download")
	if err := os.Mkdir(dl, 0o700); err != nil {
		return refuse("download", err)
	}
	var f releaseFiles
	if archive == "" {
		f, err = downloadRelease(version, dl)
	} else {
		f, err = copyLocalRelease(version, archive, dl)
	}
	if err != nil {
		return refuse("download", err)
	}
	pub, err := releasePublicKey()
	if err == nil {
		err = verifyRelease(pub, f, version)
	}
	if err != nil {
		return refuse("verify", fmt.Errorf("the release %s is not authentic: %w", version, err))
	}
	return runInstaller(f.Installer, installerEnv(version, f.Archive))
}

var errInvalidVersionRequested = errors.New("invalid version requested")

// pendingUpdatePath is the marker the backend writes to ask for an update, in the
// database folder it owns.
func pendingUpdatePath() string {
	return envOr("HSI_PENDING_UPDATE", filepath.Join(filepath.Dir(updateDBPath()), ".pending-update"))
}

// pendingUpdateMax is how much of the marker is read: a version is far shorter.
const pendingUpdateMax = 64

// readPendingUpdate reads and removes the update request marker. Its folder is held
// by descriptor and the marker opened without following a link: it must be a regular
// file with no other hard link, owned like its folder (by the app user); at most
// pendingUpdateMax bytes of its first line are read. The marker is removed whatever it
// is, so the path unit does not start the update again.
func readPendingUpdate() (string, error) {
	dir, base, err := openParentNoFollow(pendingUpdatePath())
	if err != nil {
		return "", fmt.Errorf("read the update request: %w", err)
	}
	defer dir.Close()
	defer func() { _ = unlinkat(dir, base, 0) }()
	fd, err := syscall.Openat(int(dir.Fd()), base, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return "", fmt.Errorf("read the update request %s: %w", pendingUpdatePath(), err)
	}
	f := os.NewFile(uintptr(fd), base)
	defer f.Close()
	var st, dst syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return "", err
	}
	if err := syscall.Fstat(int(dir.Fd()), &dst); err != nil {
		return "", err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Uid != dst.Uid {
		return "", fmt.Errorf("the update request %s is not a regular file of the owner of its folder", pendingUpdatePath())
	}
	b, err := io.ReadAll(io.LimitReader(f, pendingUpdateMax))
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(string(b), "\n")
	return strings.TrimSpace(line), nil
}

// updateApplyPending is what the update-apply unit runs once the backend has written
// the marker: the unit passes no value, the worker reads the marker itself.
func updateApplyPending() int {
	version, err := readPendingUpdate()
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		logger.Error("update refused", "step", "verify", "error", err.Error())
		_ = writeLast(lastResult{From: currentVersion(), Status: "refused", Step: "verify", Reason: err.Error()})
		return 1
	}
	return updateApply(version, "")
}

// installerEnv passes the worker's environment (the update-apply unit sets APP_NAME,
// INSTALL_DIR, APP_USER, BACKEND_PORT, NATS_SERVER_VERSION, SKIP_NGINX, SKIP_SEED)
// plus the version and the verified archive. Unsigned releases are never allowed here.
func installerEnv(version, archive string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "VERSION", "HSI_RELEASE_ARCHIVE", "HSI_ALLOW_UNSIGNED":
			continue
		}
		env = append(env, kv)
	}
	return append(env, "VERSION="+version, "HSI_RELEASE_ARCHIVE="+archive)
}

// copyLocalRelease copies a local archive and the SHA256SUMS, SHA256SUMS.sig and
// install.sh next to it into dir, so what is verified is what runs.
func copyLocalRelease(version, archive, dir string) (releaseFiles, error) {
	if err := checkReleaseVersion(version); err != nil {
		return releaseFiles{}, err
	}
	src := filepath.Dir(archive)
	f := releaseFiles{
		Sums:      filepath.Join(dir, "SHA256SUMS"),
		Sig:       filepath.Join(dir, "SHA256SUMS.sig"),
		Archive:   filepath.Join(dir, archiveName(version)),
		Installer: filepath.Join(dir, "install.sh"),
	}
	pairs := [][2]string{{archive, f.Archive}, {filepath.Join(src, "SHA256SUMS"), f.Sums},
		{filepath.Join(src, "SHA256SUMS.sig"), f.Sig}, {filepath.Join(src, "install.sh"), f.Installer}}
	for _, p := range pairs {
		if err := copyCapped(p[0], p[1], releaseDownloadMax); err != nil {
			return releaseFiles{}, err
		}
	}
	return f, nil
}

func copyCapped(src, dst string, max int64) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(in, max+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > max {
		err = fmt.Errorf("%s is larger than the size cap", filepath.Base(src))
	}
	return err
}

type previousVersion struct {
	Version         string     `json:"version"`
	Snapshot        *string    `json:"snapshot"`
	SnapshotCreated *time.Time `json:"snapshotCreated"`
}

// updateStatusReply: RollbackTarget is what `update rollback` brings back (the From
// of the newest snapshot taken for the current version), null when there is none;
// Previous lists every other installed version for information.
type updateStatusReply struct {
	Last            *lastResult       `json:"last"`
	History         []lastResult      `json:"history"`
	Current         string            `json:"current"`
	Previous        []previousVersion `json:"previous"`
	RollbackTarget  *previousVersion  `json:"rollbackTarget"`
	RollbackCommand string            `json:"rollbackCommand"`
}

// updateStatus is what `update status` prints and root.update.status answers.
func updateStatus() updateStatusReply {
	st := updateStatusReply{Current: currentVersion(), Previous: []previousVersion{},
		RollbackCommand: fmt.Sprintf("sudo %s-worker update rollback", unitPrefix())}
	if r, err := readLast(); err == nil {
		st.Last = r
	}
	st.History = readResultHistory()
	if st.History == nil {
		st.History = []lastResult{}
	}
	if s, ok := latestSnapshotFor(st.Current); ok {
		if fi, err := os.Lstat(filepath.Join(releasesDir(), s.Manifest.From)); err == nil && fi.IsDir() {
			dir, created := s.Dir, s.Manifest.Created
			st.RollbackTarget = &previousVersion{Version: s.Manifest.From, Snapshot: &dir, SnapshotCreated: &created}
		}
	}
	snaps := listSnapshots()
	for _, v := range installedReleases() {
		pv := previousVersion{Version: v}
		for _, s := range snaps {
			if s.Manifest.From == v {
				dir, created := s.Dir, s.Manifest.Created
				pv.Snapshot, pv.SnapshotCreated = &dir, &created
				break
			}
		}
		st.Previous = append(st.Previous, pv)
	}
	return st
}

func handleUpdateStatus(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, updateStatus())
}
