package main

import (
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
func workerEnvPath() string { return envOr("HSI_WORKER_ENV", defaultWorkerEnvFor(os.Args[0])) }

var workerNameRe = regexp.MustCompile(`^([a-z][a-z0-9-]{0,31})-worker$`)

// defaultWorkerEnvFor is /etc/<prefix>/worker.env for a worker invoked as
// <prefix>-worker (the installer links /usr/local/bin/<APP_NAME>-worker), else the
// hsi one.
func defaultWorkerEnvFor(argv0 string) string {
	if m := workerNameRe.FindStringSubmatch(filepath.Base(argv0)); m != nil {
		return filepath.Join("/etc", m[1], "worker.env")
	}
	return "/etc/hsi/worker.env"
}
func natsConfPath() string { return envOr("HSI_NATS_CONF", "/etc/hsi/nats.conf") }

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

// snapshotRel is p (absolute, or relative to the snapshot dir) relative to dir,
// refused when it leaves it.
func snapshotRel(dir, p string) (string, error) {
	rel := p
	if filepath.IsAbs(p) {
		r, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(p))
		if err != nil {
			return "", err
		}
		rel = r
	}
	rel = filepath.Clean(rel)
	if !filepath.IsLocal(rel) {
		return "", fmt.Errorf("%s is outside the snapshot", p)
	}
	return rel, nil
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
	return append(unitFiles(), fixedConfigFiles()...)
}

func fixedConfigFiles() []string {
	return []string{workerEnvPath(), backendEnvPath(), natsConfPath(), tlsConfigPath(), backupConfigPath()}
}

var unitExts = []string{"service", "timer", "path", "target"}

func unitFiles() []string {
	var files []string
	for _, ext := range unitExts {
		m, _ := filepath.Glob(filepath.Join(systemdDir(), unitPrefix()+"*."+ext))
		files = append(files, m...)
	}
	sort.Strings(files)
	return files
}

// isUnitPath tells whether p is systemdDir()/<prefix>*.{service,timer,path,target}.
func isUnitPath(p string) bool {
	if filepath.Dir(p) != filepath.Clean(systemdDir()) || !strings.HasPrefix(filepath.Base(p), unitPrefix()) {
		return false
	}
	for _, ext := range unitExts {
		if strings.HasSuffix(p, "."+ext) {
			return true
		}
	}
	return false
}

// snapshotSourceAllowed is the set of files a snapshot may save and a rollback may write.
func snapshotSourceAllowed(p string) bool {
	if isUnitPath(p) {
		return true
	}
	for _, f := range fixedConfigFiles() {
		if p == filepath.Clean(f) {
			return true
		}
	}
	return false
}

var snapshotNameRe = regexp.MustCompile(`^(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$`)

// takeSnapshot copies the database and files into <state>/<from>-<to>/, replacing an
// older snapshot of the same pair. Sources are read without following links (unit
// files that are links are saved as links); copies keep mode and owner and reach the
// disk before the manifest is written. Paths in the manifest are relative to it.
func takeSnapshot(from, to string, dbPath string, files []string) (string, error) {
	if err := checkInstalledVersion(from); err != nil {
		return "", err
	}
	if err := checkInstalledVersion(to); err != nil {
		return "", err
	}
	state, err := walkDirNoFollow(updateStateDir(), "the update state folder", true, 0o700)
	if err != nil {
		return "", err
	}
	defer state.Close()
	name := from + "-" + to
	dir := filepath.Join(updateStateDir(), name)
	// The state dir is root's alone: removing by path there is safe.
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	snap, err := mkdirAt(state, name)
	if err != nil {
		return "", err
	}
	defer snap.Close()
	filesDir, err := mkdirAt(snap, "files")
	if err != nil {
		return "", err
	}
	defer filesDir.Close()
	dbDir, err := mkdirAt(snap, "database")
	if err != nil {
		return "", err
	}
	defer dbDir.Close()

	m := snapshotManifest{From: from, To: to, Created: time.Now().UTC(), DBTarget: dbPath, Files: []snapFile{}}
	linked := fmt.Errorf("The database path %s goes through a symbolic link; updates need the real path (set HSI_UPDATE_DB)", dbPath)
	src, base, err := openParentNoFollow(dbPath)
	if notRealDir(err) {
		return "", linked
	}
	if err != nil {
		return "", fmt.Errorf("snapshot the database: %w", err)
	}
	defer src.Close()
	if st, err := statAt(src, base); err == nil && st.Mode&syscall.S_IFMT == syscall.S_IFLNK {
		return "", linked
	}
	m.Database = filepath.Join("database", base)
	if err := copyAt(src, base, dbDir, base, 0, false); err != nil {
		return "", fmt.Errorf("snapshot the database: %w", err)
	}
	if _, err := statAt(src, base+"-wal"); err == nil {
		if err := copyAt(src, base+"-wal", dbDir, base+"-wal", 0, false); err != nil {
			return "", fmt.Errorf("snapshot the database: %w", err)
		}
	}
	for i, p := range files {
		f, err := snapshotFile(filesDir, i, filepath.Clean(p))
		if err != nil {
			return "", fmt.Errorf("snapshot %s: %w", p, err)
		}
		m.Files = append(m.Files, f)
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := writeBackupFile(filepath.Join(dir, "manifest.json"), append(b, '\n'), 0o600); err != nil {
		return "", err
	}
	_ = snap.Sync()
	return dir, nil
}

func snapshotFile(filesDir *os.File, i int, p string) (snapFile, error) {
	f := snapFile{Src: p}
	parent, base, err := openParentNoFollow(p)
	if errors.Is(err, syscall.ENOENT) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	defer parent.Close()
	st, err := statAt(parent, base)
	if errors.Is(err, syscall.ENOENT) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	f.Existed = true
	f.Mode = st.Mode & 0o777
	saved := fmt.Sprintf("%d-%s", i, base)
	f.Saved = filepath.Join("files", saved)
	return f, copyAt(parent, base, filesDir, saved, 0, isUnitPath(p))
}

// mkdirAt creates dir/name (0700) and opens it without following a link.
func mkdirAt(dir *os.File, name string) (*os.File, error) {
	if err := syscall.Mkdirat(int(dir.Fd()), name, 0o700); err != nil && !errors.Is(err, syscall.EEXIST) {
		return nil, err
	}
	return openatDir(dir, name)
}

// readManifest loads a snapshot and confines what it names: the dir must be
// <state>/<from>-<to>, the database must restore to updateDBPath(), each file must be
// one a snapshot saves, and every copy must sit inside the snapshot dir.
func readManifest(dir string) (snapshotManifest, error) {
	var m snapshotManifest
	dir = filepath.Clean(dir)
	if filepath.Dir(dir) != filepath.Clean(updateStateDir()) || !snapshotNameRe.MatchString(filepath.Base(dir)) {
		return m, fmt.Errorf("%s is not a snapshot of %s", dir, updateStateDir())
	}
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return m, fmt.Errorf("read the snapshot: %w", err)
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("the snapshot manifest is unreadable: %w", err)
	}
	if checkInstalledVersion(m.From) != nil || checkInstalledVersion(m.To) != nil || filepath.Base(dir) != m.From+"-"+m.To {
		return m, fmt.Errorf("the snapshot %s does not match its manifest", dir)
	}
	if filepath.Clean(m.DBTarget) != filepath.Clean(updateDBPath()) {
		return m, fmt.Errorf("the snapshot restores the database to %s, not %s", m.DBTarget, updateDBPath())
	}
	if m.Database, err = snapshotRel(dir, m.Database); err != nil || m.Database == "." {
		return m, fmt.Errorf("the snapshot database is outside the snapshot")
	}
	for i, f := range m.Files {
		f.Src = filepath.Clean(f.Src)
		if !filepath.IsAbs(f.Src) || !snapshotSourceAllowed(f.Src) {
			return m, fmt.Errorf("the snapshot lists %s, which an update does not change", f.Src)
		}
		if f.Mode > 0o777 {
			return m, fmt.Errorf("the snapshot gives %s an invalid mode", f.Src)
		}
		if f.Existed {
			if f.Saved, err = snapshotRel(dir, f.Saved); err != nil || f.Saved == "." {
				return m, fmt.Errorf("the snapshot copy of %s is outside the snapshot", f.Src)
			}
		}
		m.Files[i] = f
	}
	return m, nil
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
// the link is never missing. It works from a held, no-follow descriptor of installRoot:
// a symlink on the way to it, or as releases/ or the version, is refused.
func switchCurrent(version string) error {
	if err := checkInstalledVersion(version); err != nil {
		return err
	}
	root, err := openDirNoFollow(installRoot())
	if err != nil {
		return err
	}
	defer root.Close()
	rel, err := openatDir(root, "releases")
	if err != nil {
		return fmt.Errorf("%s is not a real directory: %w", releasesDir(), err)
	}
	ver, err := openatDir(rel, version)
	rel.Close()
	if err != nil {
		return fmt.Errorf("version %s is not installed in %s", version, releasesDir())
	}
	ver.Close()
	tmp := fmt.Sprintf("current.tmp-%d", os.Getpid())
	if err := removeAt(root, tmp); err != nil {
		return err
	}
	if err := symlinkAt(filepath.Join(releasesDir(), version), root, tmp); err != nil {
		return err
	}
	if err := commitAt(root, tmp, "current"); err != nil {
		return fmt.Errorf("switch to %s: %w", version, err)
	}
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

// pruneSnapshots keeps the keep newest snapshots and removes the others, and any
// snapshot dir whose manifest is missing or unreadable.
func pruneSnapshots(keep int) {
	readable := map[string]bool{}
	for i, s := range listSnapshots() {
		readable[s.Dir] = true
		if i >= keep {
			removeStateDir(s.Dir)
		}
	}
	entries, _ := os.ReadDir(updateStateDir())
	for _, e := range entries {
		dir := filepath.Join(updateStateDir(), e.Name())
		if e.IsDir() && snapshotNameRe.MatchString(e.Name()) && !readable[dir] {
			removeStateDir(dir)
		}
	}
}

// pruneStaging removes apply-* staging dirs older than maxAge (a crashed apply).
func pruneStaging(maxAge time.Duration) {
	entries, _ := os.ReadDir(updateStateDir())
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "apply-") {
			continue
		}
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > maxAge {
			removeStateDir(filepath.Join(updateStateDir(), e.Name()))
		}
	}
}

func removeStateDir(dir string) {
	if err := os.RemoveAll(dir); err != nil {
		logger.Warn("update: could not remove an old update dir", "dir", dir, "error", err.Error())
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
		if err := removeRelease(v); err != nil {
			logger.Warn("update: could not remove an old release", "version", v, "error", err.Error())
		}
	}
}

// removeRelease deletes releases/<version> through descriptors only, refusing a
// symlinked installRoot or releases dir; a release that is a link is unlinked, never
// followed.
func removeRelease(version string) error {
	root, err := openDirNoFollow(installRoot())
	if err != nil {
		return err
	}
	defer root.Close()
	rel, err := openatDir(root, "releases")
	if err != nil {
		return fmt.Errorf("%s is not a real directory: %w", releasesDir(), err)
	}
	defer rel.Close()
	d, err := openatDir(rel, version)
	if notRealDir(err) {
		return removeAt(rel, version)
	}
	if err != nil {
		return err
	}
	err = removeChildren(d)
	d.Close()
	if err != nil {
		return err
	}
	return unlinkat(rel, version, atRemoveDir)
}
