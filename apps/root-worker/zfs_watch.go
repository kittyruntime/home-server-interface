package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// Watched pools (ZFS lot 1): the pools HSI imported or the admin chose to
// watch. Their datasets mounted at that time join the volume guard: when the
// pool or one of them is missing, apps using it stop and writes are refused,
// as for an LVM volume. Kept in a file of HSI's own, which older releases
// ignore.

type watchedDataset struct {
	Name       string `json:"name"`
	MountPoint string `json:"mountPoint"`
}

type watchedPool struct {
	Name     string           `json:"name"`
	GUID     string           `json:"guid"`
	Datasets []watchedDataset `json:"datasets"`
}

var zfsPoolsPath = "/etc/hsi/zfs-pools.json"

// loadWatchedPools: an absent or unreadable file watches nothing.
func loadWatchedPools() []watchedPool {
	out := []watchedPool{}
	b, err := os.ReadFile(zfsPoolsPath)
	if err != nil {
		return out
	}
	if json.Unmarshal(b, &out) != nil || out == nil {
		return []watchedPool{}
	}
	return out
}

// zfsGuardStates gives the guard state of every watched dataset: missing when
// its pool is not imported or it is not mounted, wrong when something else is
// mounted there, readonly, or ok.
func zfsGuardStates(watched []watchedPool, pools []zfsPool, _ []zfsDataset, mountOf func(mp string) (source string, readOnly bool, ok bool)) []volumeStatus {
	imported := map[string]bool{}
	for _, p := range pools {
		imported[p.GUID] = true
	}
	out := []volumeStatus{}
	for _, w := range watched {
		for _, d := range w.Datasets {
			st := volumeStatus{MountPoint: d.MountPoint, UUID: "zfs:" + w.GUID + ":" + d.Name, State: "ok"}
			src, ro, mounted := mountOf(d.MountPoint)
			switch {
			case !imported[w.GUID] || !mounted:
				st.State = "missing"
			case src != d.Name:
				st.State = "wrong"
			case ro:
				st.State = "readonly"
			}
			out = append(out, st)
		}
	}
	return out
}

// zfsMountOf reads the mount at mp from /proc/self/mountinfo.
func zfsMountOf(mp string) (string, bool, bool) {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return "", false, false
	}
	src, opts, ok := mountinfoEntry(string(b), mp)
	return src, strings.Split(opts, ",")[0] == "ro", ok
}

// zfsImportedGUIDs lists the guids of the imported pools: one short command,
// killed after probeTimeout, so a pool stuck on a failed disk cannot hang the
// guard (tests swap it).
var zfsImportedGUIDs = func() (map[string]bool, error) {
	out, err := probe("zpool", "list", "-Hp", "-o", "guid").Output()
	if err != nil {
		return nil, err
	}
	guids := map[string]bool{}
	for _, l := range strings.Fields(string(out)) {
		guids[l] = true
	}
	return guids, nil
}

// zfsGuard smooths the readings of the watched datasets: missing only on the
// second check in a row (as for an LVM volume, a pool can be slow to import at
// boot), and the last states kept when zpool itself fails.
type zfsGuard struct {
	mu   sync.Mutex
	last map[string]string // uuid -> state reported
	seen map[string]bool   // uuid -> read missing on the previous check
}

func newZfsGuard() *zfsGuard {
	return &zfsGuard{last: map[string]string{}, seen: map[string]bool{}}
}

func (g *zfsGuard) settle(raw []volumeStatus) []volumeStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]volumeStatus, len(raw))
	for i, st := range raw {
		if st.State == "missing" && !g.seen[st.UUID] {
			g.seen[st.UUID] = true
			if prev, ok := g.last[st.UUID]; ok && prev != "missing" {
				st.State = prev
			} else if !ok {
				st.State = "ok"
			}
		} else if st.State != "missing" {
			delete(g.seen, st.UUID)
		}
		g.last[st.UUID] = st.State
		out[i] = st
	}
	return out
}

// unknown: zpool did not answer; every watched dataset keeps its last state.
func (g *zfsGuard) unknown(watched []watchedPool) []volumeStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := []volumeStatus{}
	for _, w := range watched {
		for _, d := range w.Datasets {
			uuid := "zfs:" + w.GUID + ":" + d.Name
			state := g.last[uuid]
			if state == "" {
				state = "ok"
			}
			out = append(out, volumeStatus{MountPoint: d.MountPoint, UUID: uuid, State: state})
		}
	}
	return out
}

var zfsGuardState = newZfsGuard()

// zfsVolumeStatuses: the guard of the watched datasets. A watched pool on a
// host where ZFS did not load is missing as a whole.
func zfsVolumeStatuses() []volumeStatus {
	watched := loadWatchedPools()
	if len(watched) == 0 {
		return nil
	}
	var pools []zfsPool
	if zfsAvailable() {
		guids, err := zfsImportedGUIDs()
		if err != nil {
			logger.Warn("volume guard: zpool list failed, keeping the last ZFS states", "error", err)
			return zfsGuardState.unknown(watched)
		}
		for g := range guids {
			pools = append(pools, zfsPool{GUID: g})
		}
	}
	return zfsGuardState.settle(zfsGuardStates(watched, pools, nil, zfsMountOf))
}

// ── Plans ────────────────────────────────────────────────────────────────────

var (
	reZpoolName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`)
	reZpoolGUID = regexp.MustCompile(`^[0-9]{1,20}$`)
)

// watchEntry is the watched entry of an imported pool: its guid and its
// datasets mounted now.
func watchEntry(name string) (watchedPool, bool) {
	info := zfsSnapshot()
	for _, p := range info.Pools {
		if p.Name != name {
			continue
		}
		w := watchedPool{Name: name, GUID: p.GUID, Datasets: []watchedDataset{}}
		for _, d := range info.Datasets {
			if d.Pool == name && d.Mounted && zfsDatasetIsVolume(d) {
				w.Datasets = append(w.Datasets, watchedDataset{Name: d.Name, MountPoint: d.MountPoint})
			}
		}
		return w, true
	}
	return watchedPool{}, false
}

func withWatched(list []watchedPool, w watchedPool) []watchedPool {
	out := []watchedPool{}
	for _, x := range list {
		if x.GUID != w.GUID && x.Name != w.Name {
			out = append(out, x)
		}
	}
	return append(out, w)
}

func withoutWatched(list []watchedPool, name string) []watchedPool {
	out := []watchedPool{}
	for _, x := range list {
		if x.Name != name {
			out = append(out, x)
		}
	}
	return out
}

func marshalWatched(list []watchedPool) []byte {
	b, _ := json.MarshalIndent(list, "", "  ")
	return append(b, '\n')
}

func saveWatched(list []watchedPool) error {
	if err := os.MkdirAll(filepath.Dir(zfsPoolsPath), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(zfsPoolsPath, marshalWatched(list), 0o644)
}

// watchedStep writes the watched pools file with the change, showing its diff.
func watchedStep(summary string, next []watchedPool) planStep {
	before, readErr := os.ReadFile(zfsPoolsPath)
	kind := "update"
	if readErr != nil {
		kind = "create"
	}
	return planStep{Kind: kind, Target: zfsPoolsPath, Summary: summary,
		Diff: unifiedDiff(zfsPoolsPath, string(before), string(marshalWatched(next))),
		run:  func() (string, error) { return "", saveWatched(next) }}
}

func planZfsImport(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		GUID  string `json:"guid"`
		Name  string `json:"name"`
		Force bool   `json:"force"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reZpoolGUID.MatchString(req.GUID) || !reZpoolName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool"}
	}
	// Imported without mounting: a pool brought from elsewhere decides where
	// its datasets mount, and must never mount over a system folder.
	argv := []string{"zpool", "import", "-N", "-o", "cachefile=none"}
	summary := "Import the ZFS pool " + req.Name + " found on the disks, without mounting anything or changing its data"
	if req.Force {
		// Last used by another system: make sure that system no longer uses
		// these disks, or both would write to the pool.
		argv = append(argv, "-f")
		summary += ", although another system used it last"
	}
	imp := cmdStep(req.Name, summary, append(argv, "-d", "/dev/disk/by-id", req.GUID, req.Name))
	mount := planStep{Kind: "run", Target: req.Name, Deferred: true,
		Summary: "Mount its datasets without setuid programs or device files, unless one would mount outside /srv, /mnt, /media or /" + req.Name + " (a system folder): then export the pool again and stop",
		run:     func() (string, error) { return "", checkAndMountImported(req.Name) }}
	// What to watch is known once the pool is imported and its datasets mounted.
	watch := planStep{Kind: "update", Target: zfsPoolsPath, Deferred: true,
		Summary: "Watch " + req.Name + ": its datasets are guarded like any HSI volume",
		run: func() (string, error) {
			w, ok := watchEntry(req.Name)
			if !ok {
				return "", cmdError{"the pool " + req.Name + " is not imported"}
			}
			before, _ := os.ReadFile(zfsPoolsPath)
			next := withWatched(loadWatchedPools(), w)
			if err := saveWatched(next); err != nil {
				return "", err
			}
			return unifiedDiff(zfsPoolsPath, string(before), string(marshalWatched(next))), nil
		}}
	return &opPlan{Op: "zfs.import", Steps: []planStep{imp, mount, watch}, Observed: map[string]string{}}, nil
}

func planZfsWatch(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reZpoolName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool"}
	}
	w, ok := watchEntry(req.Name)
	if !ok {
		return nil, &fsError{Code: "ENOENT", Message: "The pool " + req.Name + " is not imported"}
	}
	step := watchedStep("Watch "+req.Name+": its datasets are guarded like any HSI volume", withWatched(loadWatchedPools(), w))
	return &opPlan{Op: "zfs.watch", Steps: []planStep{step}, Observed: map[string]string{}}, nil
}

func planZfsUnwatch(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reZpoolName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool"}
	}
	step := watchedStep("Stop watching "+req.Name+": its datasets are no longer guarded", withoutWatched(loadWatchedPools(), req.Name))
	return &opPlan{Op: "zfs.unwatch", Steps: []planStep{step}, Observed: map[string]string{}}, nil
}

// zfsMountTable maps each mount point of the host to its source, from
// /proc/self/mountinfo (tests swap it).
var zfsMountTable = func() map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		// After the optional fields, "-" then the fs type and the source.
		for i := 6; i < len(f)-2; i++ {
			if f[i] == "-" {
				out[unescapeMountinfo(f[4])] = unescapeMountinfo(f[i+2])
				break
			}
		}
	}
	return out
}

// resolvePrefix resolves the links of the longest existing part of p.
func resolvePrefix(p string, resolve func(string) (string, error)) string {
	rest := ""
	for cur := p; ; cur = filepath.Dir(cur) {
		if real, err := resolve(cur); err == nil {
			return filepath.Join(real, rest)
		}
		if cur == "/" {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
	}
}

// Top-level folders of a Linux system: a pool named after one gets no folder
// of its own at the root.
var systemTopLevel = map[string]bool{
	"bin": true, "boot": true, "cdrom": true, "dev": true, "etc": true, "home": true, "lib": true, "lib32": true,
	"lib64": true, "libx32": true, "lost+found": true, "media": true, "mnt": true, "opt": true, "proc": true,
	"root": true, "run": true, "sbin": true, "snap": true, "srv": true, "sys": true, "tmp": true, "usr": true, "var": true,
}

// underAllowedRoot: inside /srv, /mnt or /media (never those folders
// themselves), or in /<pool>, the place ZFS gives a pool by default, unless
// the pool is named after a system folder.
func underAllowedRoot(p, pool string) bool {
	if !systemTopLevel[pool] && (p == "/"+pool || strings.HasPrefix(p, "/"+pool+"/")) {
		return true
	}
	for _, r := range []string{"/srv", "/mnt", "/media"} {
		if strings.HasPrefix(p, r+"/") {
			return true
		}
	}
	return false
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// ofPool: a mount source that is the pool or one of its datasets.
func ofPool(source, pool string) bool {
	return source == pool || strings.HasPrefix(source, pool+"/")
}

// mountPointAllowed: a dataset of an imported pool may mount on mp only when
// mp is written plainly (absolute, clean: the kernel follows the raw path, so
// a ".." after a link would land elsewhere), in the folders data goes in
// (before and after resolving links), never on or above a folder something
// is mounted on, and never inside another volume: the mount holding mp is
// the system's root or a dataset of the same pool.
func mountPointAllowed(mp, pool string, mounts map[string]string, resolve func(string) (string, error)) bool {
	if !strings.HasPrefix(mp, "/") || mp != filepath.Clean(mp) || hasControl(mp) {
		return false
	}
	real := resolvePrefix(mp, resolve)
	for _, p := range []string{mp, real} {
		if !underAllowedRoot(p, pool) {
			return false
		}
		holder := "/"
		for m := range mounts {
			if m == "/" {
				continue
			}
			if p == m || strings.HasPrefix(m, p+"/") {
				return false
			}
			if strings.HasPrefix(p, m+"/") && len(m) > len(holder) {
				holder = m
			}
		}
		if holder != "/" && !ofPool(mounts[holder], pool) {
			return false
		}
	}
	return true
}

// checkAndMountImported mounts the datasets of a pool just imported with -N
// and -o cachefile=none. It fails closed: a line it cannot read, a dataset
// that would mount (now or later, canmount on or noauto) outside the data
// folders, a mount that does not land where it was checked: the pool is
// exported again, so nothing stays mounted and it does not come back at boot.
// Mounted datasets run no setuid program, expose no device file, and share
// nothing over NFS or SMB on their own.
func checkAndMountImported(name string) error {
	undo := func(msg string) error {
		if out, err := runArgv([]string{"zpool", "export", name}); err != nil {
			msg += "; the pool could not be exported again: " + cmdErrMessage(out, err)
		}
		return cmdError{msg}
	}
	out, err := hostOutput("zfs", "list", "-H", "-o", "name,mountpoint,canmount", "-r", "-t", "filesystem", name)
	if err != nil {
		return undo("could not list the datasets of " + name + ": " + err.Error())
	}
	mounts := zfsMountTable()
	var unsafe, mount []string
	mountPoints := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 || (f[0] != name && !strings.HasPrefix(f[0], name+"/")) {
			return undo("Not imported: a dataset line of " + name + " could not be read safely: " + strconv.Quote(line))
		}
		switch f[2] {
		case "off":
			continue
		case "on", "noauto":
		default:
			return undo("Not imported: unexpected canmount " + strconv.Quote(f[2]) + " on " + f[0])
		}
		if f[1] == "none" || f[1] == "legacy" || f[1] == "-" {
			continue
		}
		if !mountPointAllowed(f[1], name, mounts, filepath.EvalSymlinks) {
			unsafe = append(unsafe, f[0]+" ("+strconv.Quote(f[1])+")")
			continue
		}
		if f[2] == "on" {
			mount = append(mount, f[0])
			mountPoints[f[0]] = f[1]
		}
	}
	if len(unsafe) > 0 {
		return undo("Not imported: datasets of " + name + " would mount outside /srv, /mnt, /media and /" + name + ", over or inside a mounted folder: " + strings.Join(unsafe, ", ") + ". Import it by hand with zpool import -N, change their mount points (zfs set mountpoint=...), export it, then import it here.")
	}
	off := func(ds string) error {
		if out, err := runArgv([]string{"zfs", "set", "setuid=off", "devices=off", "sharenfs=off", "sharesmb=off", ds}); err != nil {
			return undo("could not turn off setuid, device files and sharing on " + ds + ": " + cmdErrMessage(out, err))
		}
		return nil
	}
	if err := off(name); err != nil {
		return err
	}
	// Parents first (shallower mount points), each checked again once the
	// datasets above it are mounted, since their content comes from the pool.
	sort.SliceStable(mount, func(i, j int) bool {
		return strings.Count(mountPoints[mount[i]], "/") < strings.Count(mountPoints[mount[j]], "/")
	})
	for _, ds := range mount {
		mp := mountPoints[ds]
		if !zfsPathSafe(mp) || !mountPointAllowed(mp, name, zfsMountTable(), filepath.EvalSymlinks) {
			return undo("stopped before mounting " + ds + ": its mount point " + mp + " goes through a link, a folder that is not root's, or over or inside a mounted folder")
		}
		if err := off(ds); err != nil {
			return err
		}
		if out, err := runArgv([]string{"zfs", "mount", ds}); err != nil {
			return undo("could not mount " + ds + ": " + cmdErrMessage(out, err))
		}
		if zfsMountTable()[mp] != ds {
			return undo(ds + " did not mount on " + mp)
		}
	}
	// Checked and mounted: the pool joins the import cache, to come back at boot.
	if out, err := runArgv([]string{"zpool", "set", "cachefile=", name}); err != nil {
		return undo("could not add " + name + " to the import cache: " + cmdErrMessage(out, err))
	}
	return nil
}

// zfsPathSafe checks a mount point right before mounting (tests swap it).
var zfsPathSafe = func(p string) bool {
	return pathSafe(p, func(_ string, fi os.FileInfo) uint32 {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			return st.Uid
		}
		return 1
	})
}

// pathSafe: no existing part of p is a link, and each existing folder is
// root's and writable by nobody else, so no one can swap a folder for a link
// between this check and the mount.
func pathSafe(p string, ownerOf func(path string, fi os.FileInfo) uint32) bool {
	return pathSafeFrom("/", p, ownerOf)
}

// pathSafeFrom checks the parts of p below from (a folder trusted as is).
func pathSafeFrom(from, p string, ownerOf func(path string, fi os.FileInfo) uint32) bool {
	rel, err := filepath.Rel(from, filepath.Clean(p))
	if err != nil || strings.HasPrefix(rel, "..") {
		return false
	}
	cur := from
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if err != nil {
			return true // the rest does not exist yet: ZFS creates it
		}
		if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() || ownerOf(cur, fi) != 0 || fi.Mode().Perm()&0o022 != 0 {
			return false
		}
	}
	return true
}
