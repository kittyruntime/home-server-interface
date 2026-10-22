package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
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
  snapshot <from> <to>                    snapshot the database and configuration, print its dir
  mark <from> <to> <snapshot> <step> [--pid N]   write the in-progress marker
  switch <version>                        point current at releases/<version>
  health <version> [--timeout 120]        wait until that version is healthy
  commit <from> <to> <snapshot>           record success, prune old versions and snapshots
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

func runUpdateCLI(args []string) int {
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
	want := map[string]int{"apply": 1, "snapshot": 2, "mark": 4, "switch": 1, "health": 1, "commit": 3, "rollback": 0, "status": 0, "recover": 0}
	if n, ok := want[args[0]]; !ok || n != len(pos) {
		return fail(2, errors.New(updateUsage))
	}

	switch args[0] {
	case "apply":
		return updateApply(pos[0], *archive)
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
	case "health":
		t := healthTargetFor(pos[0])
		t.Timeout = time.Duration(*timeout) * time.Second
		if err := waitHealthy(t); err != nil {
			return fail(1, err)
		}
	case "commit":
		if err := writeLast(lastResult{From: pos[0], To: pos[1], Status: "success"}); err != nil {
			return fail(1, err)
		}
		clearInProgress()
		if _, err := os.Stat(filepath.Join(pos[2], "manifest.json")); err != nil {
			logger.Warn("update: committed without a readable snapshot", "snapshot", pos[2])
		}
		pruneSnapshots(updateKeep)
		pruneReleases(updateKeep)
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

// updateRollbackCLI is the manual rollback (confirmed by typing the previous version)
// and the installer's (--yes; the installer holds the update lock).
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
	if !yes {
		lock, free, err := tryUpdateLock()
		if err != nil {
			return fail(err)
		}
		if !free {
			return fail(errors.New("an update is running; wait for it to finish"))
		}
		defer lock.Close()
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
// staging dir, verify it, check the archive extracts safely, then run the verified
// install.sh. A refusal changes nothing but last.json.
func updateApply(version, archive string) int {
	from := currentVersion()
	refuse := func(step string, err error) int {
		fmt.Fprintln(os.Stderr, err.Error())
		logger.Error("update refused", "version", version, "step", step, "error", err.Error())
		_ = writeLast(lastResult{From: from, To: version, Status: "refused", Step: step, Reason: err.Error()})
		return 1
	}
	if err := checkReleaseVersion(version); err != nil {
		return refuse("verify", err)
	}
	if err := os.MkdirAll(updateStateDir(), 0o700); err != nil {
		return refuse("download", err)
	}
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
	root := strings.TrimSuffix(archiveName(version), "-linux-amd64.tar.gz")
	if err := extractRelease(f.Archive, filepath.Join(stage, "release"), root); err != nil {
		return refuse("extract", fmt.Errorf("the release %s archive is unsafe: %w", version, err))
	}
	return runInstaller(f.Installer, installerEnv(version, f.Archive))
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

// Caps on what a release archive may expand to.
const (
	releaseMaxEntries = 1_000_000
	releaseMaxBytes   = 8 << 30
)

// extractRelease extracts archive (a .tar.gz whose entries all sit under root/) into
// dest. Refused: absolute or parent paths, entries outside root, links leaving dest,
// writing through a symlink, a name seen twice. Other entry types are skipped.
func extractRelease(archive, dest, root string) error {
	fh, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		return fmt.Errorf("not a gzip archive: %w", err)
	}
	defer gz.Close()
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	var total int64
	for entries := 0; ; entries++ {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("the archive is damaged: %w", err)
		}
		if entries >= releaseMaxEntries {
			return errors.New("the archive has too many entries")
		}
		rel, err := releaseEntryPath(h.Name, root)
		if err != nil {
			return err
		}
		if rel == "." {
			continue
		}
		target := filepath.Join(dest, rel)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := ensureDirs(dest, rel); err != nil {
				return err
			}
		case tar.TypeReg:
			if total += h.Size; total > releaseMaxBytes {
				return errors.New("the archive expands beyond the size cap")
			}
			if err := ensureDirs(dest, filepath.Dir(rel)); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, os.FileMode(h.Mode).Perm()|0o600)
			if err != nil {
				return fmt.Errorf("%s: %w", h.Name, err)
			}
			_, err = io.Copy(out, io.LimitReader(tr, h.Size))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if filepath.IsAbs(h.Linkname) || !filepath.IsLocal(filepath.Join(filepath.Dir(rel), h.Linkname)) {
				return fmt.Errorf("the archive holds a link leaving it: %s -> %s", h.Name, h.Linkname)
			}
			if err := ensureDirs(dest, filepath.Dir(rel)); err != nil {
				return err
			}
			if err := os.Symlink(h.Linkname, target); err != nil {
				return fmt.Errorf("%s: %w", h.Name, err)
			}
		case tar.TypeLink:
			linkRel, err := releaseEntryPath(h.Linkname, root)
			if err != nil || linkRel == "." {
				return fmt.Errorf("the archive holds a link leaving it: %s -> %s", h.Name, h.Linkname)
			}
			if err := ensureDirs(dest, filepath.Dir(linkRel)); err != nil {
				return err
			}
			if st, err := os.Lstat(filepath.Join(dest, linkRel)); err != nil || !st.Mode().IsRegular() {
				return fmt.Errorf("the archive links %s to a missing file", h.Name)
			}
			if err := ensureDirs(dest, filepath.Dir(rel)); err != nil {
				return err
			}
			if err := os.Link(filepath.Join(dest, linkRel), target); err != nil {
				return fmt.Errorf("%s: %w", h.Name, err)
			}
		}
	}
}

// releaseEntryPath is name relative to root/, refused when it leaves it.
func releaseEntryPath(name, root string) (string, error) {
	if filepath.IsAbs(name) {
		return "", fmt.Errorf("the archive holds an absolute path: %s", name)
	}
	if name != root && name != root+"/" && !strings.HasPrefix(name, root+"/") {
		return "", fmt.Errorf("the archive holds a path outside %s: %s", root, name)
	}
	rel := strings.TrimPrefix(strings.TrimPrefix(name, root), "/")
	if rel == "" {
		return ".", nil
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return "", fmt.Errorf("the archive holds a parent path: %s", name)
		}
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if !filepath.IsLocal(clean) {
		return "", fmt.Errorf("the archive holds a path outside it: %s", name)
	}
	return clean, nil
}

// ensureDirs creates each directory of rel under dest, refusing one that is a symlink
// or a file, so nothing is ever written through a link.
func ensureDirs(dest, rel string) error {
	if rel == "." || rel == "" {
		return nil
	}
	cur := dest
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		st, err := os.Lstat(cur)
		switch {
		case errors.Is(err, os.ErrNotExist):
			if err := os.Mkdir(cur, 0o755); err != nil {
				return err
			}
		case err != nil:
			return err
		case !st.IsDir():
			return fmt.Errorf("the archive writes through %s, which is not a directory", strings.TrimPrefix(cur, dest+"/"))
		}
	}
	return nil
}

type previousVersion struct {
	Version         string     `json:"version"`
	Snapshot        *string    `json:"snapshot"`
	SnapshotCreated *time.Time `json:"snapshotCreated"`
}

type updateStatusReply struct {
	Last     *lastResult       `json:"last"`
	Current  string            `json:"current"`
	Previous []previousVersion `json:"previous"`
}

// updateStatus is what `update status` prints and root.update.status answers.
func updateStatus() updateStatusReply {
	st := updateStatusReply{Current: currentVersion(), Previous: []previousVersion{}}
	if r, err := readLast(); err == nil {
		st.Last = r
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
