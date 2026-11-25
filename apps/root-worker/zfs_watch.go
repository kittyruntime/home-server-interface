package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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

// zfsVolumeStatuses: the guard of the watched datasets. A watched pool on a
// host where ZFS did not load is missing as a whole.
func zfsVolumeStatuses() []volumeStatus {
	watched := loadWatchedPools()
	if len(watched) == 0 {
		return nil
	}
	info := zfsSnapshot()
	return zfsGuardStates(watched, info.Pools, info.Datasets, zfsMountOf)
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
		GUID string `json:"guid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reZpoolGUID.MatchString(req.GUID) || !reZpoolName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool"}
	}
	// Imported without mounting: a pool brought from elsewhere decides where
	// its datasets mount, and must never mount over a system folder.
	imp := cmdStep(req.Name, "Import the ZFS pool "+req.Name+" found on the disks, without mounting anything or changing its data",
		[]string{"zpool", "import", "-N", "-d", "/dev/disk/by-id", req.GUID, req.Name})
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

// zfsCurrentMounts lists the mount points of the host (tests swap it).
var zfsCurrentMounts = func() []string {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if f := strings.Fields(line); len(f) > 4 {
			out = append(out, unescapeMountinfo(f[4]))
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

// mountPointAllowed: a dataset of an imported pool may mount on mp only in
// the folders data goes in (before and after resolving links), and never on
// or above a folder something is already mounted on, which it would hide.
func mountPointAllowed(mp, pool string, mounts []string, resolve func(string) (string, error)) bool {
	if !strings.HasPrefix(mp, "/") {
		return false
	}
	clean := filepath.Clean(mp)
	real := resolvePrefix(clean, resolve)
	for _, p := range []string{clean, real} {
		if !underAllowedRoot(p, pool) {
			return false
		}
		for _, m := range mounts {
			if m != "/" && (p == m || strings.HasPrefix(m, p+"/")) {
				return false
			}
		}
	}
	return true
}

// checkAndMountImported mounts the datasets of a pool just imported with -N.
// If one would mount itself outside the data folders, or over something
// already mounted (canmount=on), nothing is mounted and the pool is exported
// again, so that it does not mount there at the next boot either. Mounted
// datasets run no setuid program and expose no device file.
func checkAndMountImported(name string) error {
	out, err := hostOutput("zfs", "list", "-H", "-o", "name,mountpoint,canmount", "-r", "-t", "filesystem", name)
	if err != nil {
		return cmdError{"could not list the datasets of " + name + ": " + err.Error()}
	}
	mounts := zfsCurrentMounts()
	var unsafe, mount []string
	mountPoints := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 3 || f[2] != "on" || !strings.HasPrefix(f[1], "/") {
			continue
		}
		if !mountPointAllowed(f[1], name, mounts, filepath.EvalSymlinks) {
			unsafe = append(unsafe, f[0]+" ("+f[1]+")")
		} else {
			mount = append(mount, f[0])
			mountPoints[f[0]] = f[1]
		}
	}
	if len(unsafe) > 0 {
		if out, err := runArgv([]string{"zpool", "export", name}); err != nil {
			return cmdError{"datasets of " + name + " would mount outside the data folders (" + strings.Join(unsafe, ", ") + ") and the pool could not be exported again: " + cmdErrMessage(out, err)}
		}
		return cmdError{"Not imported: datasets of " + name + " would mount outside /srv, /mnt, /media and /" + name + ", or over a mounted folder: " + strings.Join(unsafe, ", ") + ". Import it by hand with zpool import -N, change their mount points (zfs set mountpoint=...), export it, then import it here."}
	}
	// One by one, parents first: each mount point is checked again once the
	// datasets above it are mounted, since their content comes from the pool.
	for _, ds := range mount {
		mp := mountPoints[ds]
		if pathHasLink(mp) || !mountPointAllowed(mp, name, zfsCurrentMounts(), filepath.EvalSymlinks) {
			return cmdError{"stopped before mounting " + ds + ": its mount point " + mp + " goes through a link or over a mounted folder"}
		}
		if out, err := runArgv([]string{"zfs", "set", "setuid=off", "devices=off", ds}); err != nil {
			return cmdError{"could not turn off setuid and device files on " + ds + ": " + cmdErrMessage(out, err)}
		}
		if out, err := runArgv([]string{"zfs", "mount", ds}); err != nil {
			return cmdError{"could not mount " + ds + ": " + cmdErrMessage(out, err)}
		}
	}
	return nil
}

// pathHasLink: some existing part of p is a symbolic link.
func pathHasLink(p string) bool {
	cur := "/"
	for _, part := range strings.Split(strings.Trim(filepath.Clean(p), "/"), "/") {
		if part == "" {
			continue
		}
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if err != nil {
			return false // the rest does not exist yet: ZFS creates it
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return true
		}
	}
	return false
}
