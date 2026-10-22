package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Safe updates (#9a): state on disk ────────────────────────────────────────
// <state>/in-progress.json while an update runs, <state>/last.json for the last
// outcome, <state>/<from>-<to>/ for each snapshot (manifest.json, the database
// and the configuration files the installer rewrites). install.sh writes the
// first snapshot itself when the previous worker has no `update snapshot`, with
// the same manifest field names.

func updateStateDir() string { return envOr("HSI_UPDATE_STATE", "/var/lib/hsi/update") }
func installRoot() string    { return envOr("HSI_INSTALL_DIR", "/opt/hsi") }
func releasesDir() string    { return filepath.Join(installRoot(), "releases") }
func currentLink() string    { return filepath.Join(installRoot(), "current") }
func updateLockPath() string { return filepath.Join(updateStateDir(), "update.lock") }
func updateDBPath() string {
	return envOr("HSI_UPDATE_DB", filepath.Join(installRoot(), "database", "data", "hsi.db"))
}
func workerEnvPath() string { return envOr("HSI_WORKER_ENV", "/etc/hsi/worker.env") }
func natsConfPath() string  { return envOr("HSI_NATS_CONF", "/etc/hsi/nats.conf") }

// installedVersionRe also accepts the name the installer gives a flat install
// it moves under releases/ ("v0.0.0-flat").
var installedVersionRe = regexp.MustCompile(`^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`)

func checkInstalledVersion(v string) error {
	if !installedVersionRe.MatchString(v) {
		return fmt.Errorf("invalid version %q", v)
	}
	return nil
}

type snapshotManifest struct {
	From     string     `json:"from"`
	To       string     `json:"to"`
	Created  time.Time  `json:"created"`
	Database string     `json:"database"` // the copy, absolute or relative to the snapshot dir
	DBTarget string     `json:"dbTarget"` // the live database it restores to
	Files    []snapFile `json:"files"`
}

// snapFile is one configuration file. Saved is absolute or relative to the snapshot
// dir; Mode holds the permission bits as a number (0600 is 384).
type snapFile struct {
	Src     string `json:"src"`
	Saved   string `json:"saved"`
	Mode    uint32 `json:"mode"`
	Existed bool   `json:"existed"`
}

type inProgress struct {
	From     string    `json:"from"`
	To       string    `json:"to"`
	Snapshot string    `json:"snapshot"`
	Step     string    `json:"step"`
	Started  time.Time `json:"started"`
	PID      int       `json:"pid"`
}

// lastResult is the outcome of the last update; Status is success, rolled-back,
// rollback-failed or refused.
type lastResult struct {
	From   string    `json:"from"`
	To     string    `json:"to"`
	Status string    `json:"status"`
	Step   string    `json:"step"`
	Reason string    `json:"reason"`
	At     time.Time `json:"at"`
}

func snapshotPath(dir, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(dir, p)
}

// snapshotConfigFiles lists what the installer rewrites: the unit files of the
// prefix and the configuration HSI generates.
func snapshotConfigFiles() []string {
	files := unitFiles()
	return append(files, workerEnvPath(), backendEnvPath(), natsConfPath(), tlsConfigPath(), backupConfigPath())
}

func unitFiles() []string {
	var files []string
	for _, ext := range []string{"service", "timer", "path"} {
		m, _ := filepath.Glob(filepath.Join(systemdDir(), unitPrefix()+"*."+ext))
		files = append(files, m...)
	}
	sort.Strings(files)
	return files
}

// takeSnapshot copies the database and files into <state>/<from>-<to>/, replacing an
// older snapshot of the same pair. Copies keep mode and owner and reach the disk
// before the manifest is written.
func takeSnapshot(from, to string, dbPath string, files []string) (string, error) {
	if err := checkInstalledVersion(from); err != nil {
		return "", err
	}
	if err := checkInstalledVersion(to); err != nil {
		return "", err
	}
	if err := os.MkdirAll(updateStateDir(), 0o700); err != nil {
		return "", err
	}
	dir := filepath.Join(updateStateDir(), from+"-"+to)
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(dir, "files"), 0o700); err != nil {
		return "", err
	}
	m := snapshotManifest{From: from, To: to, Created: time.Now().UTC(), DBTarget: dbPath, Files: []snapFile{}}
	m.Database = filepath.Join(dir, "database", filepath.Base(dbPath))
	if err := os.MkdirAll(filepath.Dir(m.Database), 0o700); err != nil {
		return "", err
	}
	if err := copyPreserving(dbPath, m.Database); err != nil {
		return "", fmt.Errorf("snapshot the database: %w", err)
	}
	if _, err := os.Lstat(dbPath + "-wal"); err == nil {
		if err := copyPreserving(dbPath+"-wal", m.Database+"-wal"); err != nil {
			return "", fmt.Errorf("snapshot the database: %w", err)
		}
	}
	for i, src := range files {
		f := snapFile{Src: src}
		st, err := os.Lstat(src)
		switch {
		case errors.Is(err, os.ErrNotExist):
			m.Files = append(m.Files, f)
			continue
		case err != nil:
			return "", err
		}
		f.Existed = true
		f.Mode = uint32(st.Mode().Perm())
		f.Saved = filepath.Join(dir, "files", fmt.Sprintf("%d-%s", i, filepath.Base(src)))
		if err := copyPreserving(src, f.Saved); err != nil {
			return "", fmt.Errorf("snapshot %s: %w", src, err)
		}
		m.Files = append(m.Files, f)
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := writeBackupFile(filepath.Join(dir, "manifest.json"), append(b, '\n'), 0o600); err != nil {
		return "", err
	}
	syncDir(dir)
	return dir, nil
}

func readManifest(dir string) (snapshotManifest, error) {
	var m snapshotManifest
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return m, fmt.Errorf("read the snapshot: %w", err)
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("the snapshot manifest is unreadable: %w", err)
	}
	if checkInstalledVersion(m.From) != nil || checkInstalledVersion(m.To) != nil || m.Database == "" || !filepath.IsAbs(m.DBTarget) {
		return m, errors.New("the snapshot manifest is incomplete")
	}
	for _, f := range m.Files {
		if !filepath.IsAbs(f.Src) || (f.Existed && f.Saved == "") {
			return m, errors.New("the snapshot manifest lists an invalid file")
		}
	}
	return m, nil
}

// copyPreserving copies src to dst (a symlink as a symlink, like cp -P), keeping the
// mode and the owner; the data is synced and lands with a rename.
func copyPreserving(src, dst string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	tmp := dst + ".hsi-tmp"
	_ = os.Remove(tmp)
	if st.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		if err := os.Symlink(target, tmp); err != nil {
			return err
		}
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			_ = os.Lchown(tmp, int(sys.Uid), int(sys.Gid))
		}
		return os.Rename(tmp, dst)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", src)
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && err == nil {
		err = out.Chown(int(sys.Uid), int(sys.Gid))
	}
	if err == nil {
		err = out.Chmod(st.Mode().Perm())
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, dst)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	syncDir(filepath.Dir(dst))
	return nil
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

func writeStateJSON(name string, v any) error {
	if err := os.MkdirAll(updateStateDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	return writeBackupFile(filepath.Join(updateStateDir(), name), append(b, '\n'), 0o644)
}

func writeInProgress(p inProgress) error { return writeStateJSON("in-progress.json", p) }

func clearInProgress() { _ = os.Remove(filepath.Join(updateStateDir(), "in-progress.json")) }

func readInProgress() (*inProgress, error) {
	b, err := os.ReadFile(filepath.Join(updateStateDir(), "in-progress.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p inProgress
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("in-progress.json is unreadable: %w", err)
	}
	return &p, nil
}

func writeLast(r lastResult) error {
	if r.At.IsZero() {
		r.At = time.Now().UTC()
	}
	return writeStateJSON("last.json", r)
}

func readLast() (*lastResult, error) {
	b, err := os.ReadFile(filepath.Join(updateStateDir(), "last.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r lastResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("last.json is unreadable: %w", err)
	}
	return &r, nil
}

// tryUpdateLock takes <state>/update.lock without waiting; ok is false when another
// process (the installer) holds it.
func tryUpdateLock() (f *os.File, ok bool, err error) {
	if err := os.MkdirAll(updateStateDir(), 0o700); err != nil {
		return nil, false, err
	}
	f, err = os.OpenFile(updateLockPath(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, err
	}
	if err := flockExclusive(f); err != nil {
		f.Close()
		if err == syscall.EWOULDBLOCK {
			return nil, false, nil
		}
		return nil, false, err
	}
	return f, true, nil
}

// switchCurrent points installRoot()/current at releases/<version> with a rename, so
// the link is never missing.
func switchCurrent(version string) error {
	if err := checkInstalledVersion(version); err != nil {
		return err
	}
	target := filepath.Join(releasesDir(), version)
	if st, err := os.Stat(target); err != nil || !st.IsDir() {
		return fmt.Errorf("version %s is not installed in %s", version, releasesDir())
	}
	tmp := fmt.Sprintf("%s.tmp-%d", currentLink(), os.Getpid())
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, currentLink()); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("switch to %s: %w", version, err)
	}
	syncDir(installRoot())
	return nil
}

// currentVersion is the release the current link points to, else the VERSION file
// of a flat install, else "".
func currentVersion() string {
	if target, err := os.Readlink(currentLink()); err == nil {
		return filepath.Base(target)
	}
	b, _ := os.ReadFile(filepath.Join(installRoot(), "VERSION"))
	return strings.TrimSpace(string(b))
}

// compareVersions orders vX.Y.Z numerically; a suffix ("-flat") sorts before the
// same version without one.
func compareVersions(a, b string) int {
	pa, sa := splitVersion(a)
	pb, sb := splitVersion(b)
	for i := range pa {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case sa == sb:
		return 0
	case sa == "":
		return 1
	case sb == "":
		return -1
	case sa < sb:
		return -1
	}
	return 1
}

func splitVersion(v string) ([3]int, string) {
	var n [3]int
	v = strings.TrimPrefix(v, "v")
	core, suffix, _ := strings.Cut(v, "-")
	for i, p := range strings.SplitN(core, ".", 3) {
		n[i], _ = strconv.Atoi(p)
	}
	return n, suffix
}

type updateSnapshot struct {
	Dir      string
	Manifest snapshotManifest
}

// listSnapshots returns the readable snapshots, newest first.
func listSnapshots() []updateSnapshot {
	entries, _ := os.ReadDir(updateStateDir())
	var out []updateSnapshot
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(updateStateDir(), e.Name())
		m, err := readManifest(dir)
		if err != nil || e.Name() != m.From+"-"+m.To {
			continue
		}
		out = append(out, updateSnapshot{Dir: dir, Manifest: m})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Manifest.Created.After(out[j].Manifest.Created) })
	return out
}

func pruneSnapshots(keep int) {
	for i, s := range listSnapshots() {
		if i >= keep {
			if err := os.RemoveAll(s.Dir); err != nil {
				logger.Warn("update: could not remove an old snapshot", "dir", s.Dir, "error", err.Error())
			}
		}
	}
}

// installedReleases lists releases/<version> other than current, newest version first.
func installedReleases() []string {
	entries, _ := os.ReadDir(releasesDir())
	cur := currentVersion()
	var out []string
	for _, e := range entries {
		if e.IsDir() && e.Name() != cur && installedVersionRe.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return compareVersions(out[i], out[j]) > 0 })
	return out
}

// pruneReleases keeps current, the keep newest other versions and any version a
// remaining snapshot rolls back to.
func pruneReleases(keep int) {
	needed := map[string]bool{}
	for _, s := range listSnapshots() {
		needed[s.Manifest.From] = true
	}
	for i, v := range installedReleases() {
		if i < keep || needed[v] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(releasesDir(), v)); err != nil {
			logger.Warn("update: could not remove an old release", "version", v, "error", err.Error())
		}
	}
}
