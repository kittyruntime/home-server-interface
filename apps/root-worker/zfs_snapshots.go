package main

import (
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
	"golang.org/x/sys/unix"
)

// ── ZFS snapshots: list, take, delete, roll back, browse and restore ────────

var zfsSnapshotRulesPath = "/etc/hsi/zfs-snapshots.json"

type zfsSnap struct {
	Name    string `json:"name"` // dataset@short
	Dataset string `json:"dataset"`
	Short   string `json:"short"`
	Created int64  `json:"created"` // unix seconds
	Used    int64  `json:"used"`    // space only this snapshot holds
	Refer   int64  `json:"refer"`   // data it shows
}

type snapRule struct {
	Dataset string `json:"dataset"`
	Every   string `json:"every"` // hourly, daily, weekly, monthly
	Keep    int    `json:"keep"`
}

var snapEvery = map[string]bool{"hourly": true, "daily": true, "weekly": true, "monthly": true}

var reSnapShort = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// parseZfsSnapshots reads `zfs list -Hp -t snapshot -o name,creation,used,referenced`.
func parseZfsSnapshots(out string) []zfsSnap {
	snaps := []zfsSnap{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) < 4 {
			continue
		}
		ds, short, ok := strings.Cut(f[0], "@")
		if !ok {
			continue
		}
		snaps = append(snaps, zfsSnap{Name: f[0], Dataset: ds, Short: short, Created: atoi64(f[1]), Used: atoi64(f[2]), Refer: atoi64(f[3])})
	}
	return snaps
}

// listZfsSnapshots: every snapshot, oldest first.
func listZfsSnapshots() []zfsSnap {
	if !zfsAvailable() {
		return []zfsSnap{}
	}
	out, err := hostOutput("zfs", "list", "-Hp", "-t", "snapshot", "-o", "name,creation,used,referenced", "-s", "createtxg")
	if err != nil {
		return []zfsSnap{}
	}
	return parseZfsSnapshots(string(out))
}

func snapshotsOf(all []zfsSnap, dataset string) []zfsSnap {
	res := []zfsSnap{}
	for _, s := range all {
		if s.Dataset == dataset {
			res = append(res, s)
		}
	}
	return res
}

// splitSnapshot checks a snapshot name: a valid dataset, @, a valid short name.
func splitSnapshot(name string) (dataset, short string, ok bool) {
	dataset, short, found := strings.Cut(name, "@")
	if !found || !reSnapShort.MatchString(short) {
		return "", "", false
	}
	if _, _, _, ok := splitDataset(dataset); !ok && !reZpoolName.MatchString(dataset) {
		return "", "", false
	}
	return dataset, short, true
}

func findSnapshot(name string) (*zfsSnap, *fsError) {
	if _, _, ok := splitSnapshot(name); !ok {
		return nil, &fsError{Code: "ERR", Message: "invalid snapshot"}
	}
	for _, s := range listZfsSnapshots() {
		if s.Name == name {
			return &s, nil
		}
	}
	return nil, &fsError{Code: "ENOENT", Message: name + " does not exist"}
}

func loadSnapRules() []snapRule {
	rules := []snapRule{}
	if b, err := os.ReadFile(zfsSnapshotRulesPath); err == nil {
		_ = json.Unmarshal(b, &rules)
	}
	return rules
}

func marshalSnapRules(rules []snapRule) []byte {
	b, _ := json.MarshalIndent(rules, "", "  ")
	return append(b, '\n')
}

// cleanSnapPath: a path relative to a dataset's root, without "..". "" is the root.
func cleanSnapPath(p string) (string, bool) {
	if strings.ContainsRune(p, 0) || strings.HasPrefix(p, "/") {
		return "", false
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "", false
		}
	}
	c := path.Clean("/" + p)[1:]
	return c, true
}

// snapshotMount checks the snapshot exists and its dataset is mounted (its
// .zfs folder lives there), and gives the mount point.
var snapshotMount = func(snapshot string) (string, *fsError) {
	s, fe := findSnapshot(snapshot)
	if fe != nil {
		return "", fe
	}
	d := findDataset(zfsSnapshot().Datasets, s.Dataset)
	if d == nil || !d.Mounted || !strings.HasPrefix(d.MountPoint, "/") {
		return "", &fsError{Code: "ERR", Message: s.Dataset + " is not mounted: its snapshots cannot be browsed"}
	}
	return d.MountPoint, nil
}

// openNoLinks opens root/rel as a directory, refusing a link at any part.
func openNoLinks(root, rel string) (int, error) {
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	if rel == "" {
		return fd, nil
	}
	for _, part := range strings.Split(rel, "/") {
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

type snapEntry struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"` // dir, file, link, dataset (a child's mount point), other
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
}

const maxSnapEntries = 5000

// snapshotLs lists a folder of a snapshot, never following a link.
func snapshotLs(snapshot, p string) ([]snapEntry, bool, *fsError) {
	rel, ok := cleanSnapPath(p)
	if !ok {
		return nil, false, &fsError{Code: "ERR", Message: "invalid path"}
	}
	mount, fe := snapshotMount(snapshot)
	if fe != nil {
		return nil, false, fe
	}
	_, short, _ := splitSnapshot(snapshot)
	fd, err := openNoLinks(filepath.Join(mount, ".zfs", "snapshot", short), rel)
	if err != nil {
		return nil, false, &fsError{Code: "ERR", Message: "cannot open " + p + " in the snapshot (a link or not a folder)"}
	}
	dir := os.NewFile(uintptr(fd), "snapshot")
	defer dir.Close()
	names, _ := dir.Readdirnames(maxSnapEntries + 1) // io.EOF on an empty folder
	truncated := len(names) > maxSnapEntries
	if truncated {
		names = names[:maxSnapEntries]
	}
	sort.Strings(names)
	children := childMountsOf(mount)
	entries := []snapEntry{}
	for _, n := range names {
		var st unix.Stat_t
		if unix.Fstatat(fd, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		kind := "other"
		if children[filepath.Join(mount, rel, n)] {
			kind = "dataset" // another dataset mounts here: its files are in its own snapshots
			entries = append(entries, snapEntry{Name: n, Kind: kind, MTime: st.Mtim.Sec})
			continue
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			kind = "dir"
		case unix.S_IFREG:
			kind = "file"
		case unix.S_IFLNK:
			kind = "link"
		}
		entries = append(entries, snapEntry{Name: n, Kind: kind, Size: st.Size, MTime: st.Mtim.Sec})
	}
	return entries, truncated, nil
}

// restoredName: "photo.jpg" restored on 2026-11-26 10:05 becomes
// "photo (restored 2026-11-26 10-05).jpg"; a folder or a dot file keeps
// its whole name before the suffix.
func restoredName(base string, isDir bool, at time.Time) string {
	suffix := " (restored " + at.Format("2006-01-02 15-04") + ")"
	ext := filepath.Ext(base)
	if isDir || ext == "" || ext == base {
		return base + suffix
	}
	return strings.TrimSuffix(base, ext) + suffix + ext
}

func planZfsSnapshotRestore(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Snapshot string `json:"snapshot"`
		Path     string `json:"path"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	rel, ok := cleanSnapPath(req.Path)
	if !ok || rel == "" {
		return nil, &fsError{Code: "ERR", Message: "pick a file or a folder to restore"}
	}
	mount, fe := snapshotMount(req.Snapshot)
	if fe != nil {
		return nil, fe
	}
	_, short, _ := splitSnapshot(req.Snapshot)
	snapRoot := filepath.Join(mount, ".zfs", "snapshot", short)
	parentRel, base := path.Split(rel)
	parentRel = strings.TrimSuffix(parentRel, "/")
	// The source: its folders are real folders of the snapshot (read-only).
	sfd, err := openNoLinks(snapRoot, parentRel)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: req.Path + " is not in the snapshot"}
	}
	var st unix.Stat_t
	err = unix.Fstatat(sfd, base, &st, unix.AT_SYMLINK_NOFOLLOW)
	unix.Close(sfd)
	if err != nil {
		return nil, &fsError{Code: "ENOENT", Message: req.Path + " is not in the snapshot"}
	}
	// The destination folder: the same folder in the live dataset, no link on the way.
	dfd, err := openNoLinks(mount, parentRel)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: "the folder of " + req.Path + " no longer exists as a folder in " + mount + ": restore its parent folder instead"}
	}
	isDir := st.Mode&unix.S_IFMT == unix.S_IFDIR
	unix.Close(dfd)
	if isChildMount(mount, rel) {
		return nil, &fsError{Code: "ERR", Message: req.Path + " is another dataset mounted here: browse that dataset's own snapshots"}
	}
	if restoreBusy.Load() {
		return nil, &fsError{Code: "EBUSY", Message: "a restore is still copying: wait for it to finish"}
	}
	src := filepath.Join(snapRoot, rel)
	// The name carries the time of the copy, so it is not in the plan: a plan
	// checked a second later must stay the same.
	shown := restoredName(base, isDir, time.Date(2006, 1, 2, 15, 4, 0, 0, time.Local))
	shown = strings.Replace(shown, "2006-01-02 15-04", "<date> <time>", 1)
	target := filepath.Join(mount, parentRel, shown)
	step := planStep{Kind: "create", Target: target,
		Summary: "Copy " + req.Path + " from the snapshot " + short + " next to the original, as " + shown + " (nothing is overwritten)",
		Command: []string{"cp", "-a", "--reflink=auto", "--", src, target},
		run: func() (string, error) {
			return restoreFromSnapshot(mount, parentRel, src, restoredName(base, isDir, zfsNow()))
		}}
	return &opPlan{Op: "zfs.snapshot.restore", Steps: []planStep{step}, Observed: map[string]string{}}, nil
}

// restoreBusy: one restore copies at a time (a long one goes on in the background).
var restoreBusy atomic.Bool

// restoreWait: how long a restore waits for its copy before letting it finish
// in the background (the dashboard's request gives up after 3 minutes).
var restoreWait = 2 * time.Minute

// isChildMount: rel is where a child dataset mounts inside mount. In the
// parent's snapshot it is an empty folder, not that dataset's files.
func isChildMount(mount, rel string) bool {
	return childMountsOf(mount)[filepath.Join(mount, rel)]
}

// childMountsOf: the mount points of the datasets mounted below mount.
var childMountsOf = func(mount string) map[string]bool {
	res := map[string]bool{}
	for _, d := range zfsSnapshot().Datasets {
		if d.Mounted && strings.HasPrefix(d.MountPoint, mount+"/") {
			res[d.MountPoint] = true
		}
	}
	return res
}

// restoreFromSnapshot copies src into a folder only root can write, made in
// the destination folder held open. The copy runs inside that folder by its
// descriptor (its name can be changed by the users of the folder, never what
// it is), then is moved in place without replacing anything.
func restoreFromSnapshot(mount, parentRel, src, name string) (string, error) {
	dfd, err := openNoLinks(mount, parentRel)
	if err != nil {
		return "", errors.New("the destination folder changed: " + err.Error())
	}
	tmp := ".hsi-restore-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := unix.Mkdirat(dfd, tmp, 0o700); err != nil {
		unix.Close(dfd)
		return "", err
	}
	tfd, err := unix.Openat(dfd, tmp, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	var tst unix.Stat_t
	if err == nil {
		err = unix.Fstat(tfd, &tst)
		// The folder just made: ours, 0700 and empty. A folder swapped in
		// meanwhile (even another root-owned one) is refused.
		if err == nil && (int(tst.Uid) != restoreOwnerUID() || tst.Mode&0o7777 != 0o700 || !emptyDirFd(tfd)) {
			err = errors.New("the temporary folder was replaced")
		}
	}
	if err != nil {
		if tfd >= 0 {
			unix.Close(tfd)
		}
		unix.Close(dfd)
		return "", err
	}
	if !restoreBusy.CompareAndSwap(false, true) {
		finishRestore(dfd, tfd, tmp, tst, false)
		return "", errors.New("a restore is still copying: wait for it to finish")
	}
	done := make(chan error, 1)
	go func() {
		here := "/proc/" + strconv.Itoa(os.Getpid()) + "/fd/" + strconv.Itoa(tfd)
		out, err := copyArgv(here, []string{"cp", "-a", "--reflink=auto", "--", src, "x"})
		if err != nil {
			err = cmdError{cmdErrMessage(out, err)}
		} else if rerr := unix.Renameat2(tfd, "x", dfd, name, unix.RENAME_NOREPLACE); rerr != nil {
			err = errors.New("could not put " + name + " in place: " + rerr.Error())
		}
		finishRestore(dfd, tfd, tmp, tst, true)
		if err != nil {
			logger.Warn("zfs restore", "target", name, "error", err.Error())
		}
		done <- err
	}()
	select {
	case err := <-done:
		return "", err
	case <-time.After(restoreWait):
		return "still copying: " + name + " appears next to the original once done", nil
	}
}

// emptyDirFd: the folder open on fd holds nothing (only . and ..).
func emptyDirFd(fd int) bool {
	if _, err := unix.Seek(fd, 0, 0); err != nil {
		return false
	}
	buf := make([]byte, 4096)
	n, err := unix.Getdents(fd, buf)
	if err != nil {
		return false
	}
	names := 0
	for off := 0; off < n; {
		reclen := int(buf[off+16]) | int(buf[off+17])<<8
		name := buf[off+19 : off+reclen]
		if i := strings.IndexByte(string(name), 0); i >= 0 {
			name = name[:i]
		}
		if string(name) != "." && string(name) != ".." {
			names++
		}
		off += reclen
	}
	return names == 0
}

// finishRestore removes what is left of the temporary folder (only if it is
// still the folder HSI made) and releases the descriptors.
func finishRestore(dfd, tfd int, tmp string, tst unix.Stat_t, busy bool) {
	here := "/proc/" + strconv.Itoa(os.Getpid()) + "/fd/" + strconv.Itoa(tfd)
	_, _ = copyArgv(here, []string{"rm", "-rf", "--one-file-system", "--", "x"})
	var now unix.Stat_t
	if unix.Fstatat(dfd, tmp, &now, unix.AT_SYMLINK_NOFOLLOW) == nil && now.Ino == tst.Ino && now.Dev == tst.Dev {
		_ = unix.Unlinkat(dfd, tmp, unix.AT_REMOVEDIR)
	}
	unix.Close(tfd)
	unix.Close(dfd)
	if busy {
		restoreBusy.Store(false)
	}
}

// copyArgv runs a command of a restore in the folder dir (tests keep the real one).
var copyArgv = func(dir string, argv []string) ([]byte, error) {
	c := command(argv[0], argv[1:]...)
	c.Dir = dir
	return c.CombinedOutput()
}

func planZfsSnapshotCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Dataset string `json:"dataset"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if findDataset(zfsSnapshot().Datasets, req.Dataset) == nil {
		return nil, &fsError{Code: "ENOENT", Message: req.Dataset + " does not exist"}
	}
	// Named at the time it is taken, so the plan stays the same until then.
	shown := req.Dataset + "@hsi-manual-<date>-<time>"
	step := planStep{Kind: "run", Target: req.Dataset, Summary: "Take a snapshot of " + req.Dataset + " (" + shown + ")",
		Command: []string{"zfs", "snapshot", shown},
		run: func() (string, error) {
			name := req.Dataset + "@hsi-manual-" + zfsNow().Format("20060102-150405")
			if out, err := runArgv([]string{"zfs", "snapshot", name}); err != nil {
				return "", cmdError{cmdErrMessage(out, err)}
			}
			return name, nil
		}}
	return &opPlan{Op: "zfs.snapshot.create", Steps: []planStep{step}, Observed: map[string]string{}}, nil
}

func planZfsSnapshotDestroy(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Snapshot string `json:"snapshot"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	s, fe := findSnapshot(req.Snapshot)
	if fe != nil {
		return nil, fe
	}
	step := cmdStep(s.Name, "Delete the snapshot "+s.Name+" (the files it alone keeps are gone)", []string{"zfs", "destroy", s.Name})
	step.Destructive = true
	return &opPlan{Op: "zfs.snapshot.destroy", Steps: []planStep{step}, Observed: map[string]string{"created": strconv.FormatInt(s.Created, 10)}}, nil
}

func planZfsSnapshotRollback(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Snapshot string `json:"snapshot"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	all := listZfsSnapshots()
	var target *zfsSnap
	newer := []string{}
	for _, s := range all {
		if target != nil && s.Dataset == target.Dataset {
			newer = append(newer, s.Short)
		}
		if s.Name == req.Snapshot {
			t := s
			target = &t
		}
	}
	if _, _, ok := splitSnapshot(req.Snapshot); !ok || target == nil {
		return nil, &fsError{Code: "ENOENT", Message: req.Snapshot + " does not exist"}
	}
	// zfs rollback -r cannot delete a snapshot that has clones or holds: say
	// so now rather than after the confirmation.
	if len(newer) > 0 {
		args := []string{"get", "-Hp", "-o", "name,property,value", "clones,userrefs"}
		for _, n := range newer {
			args = append(args, target.Dataset+"@"+n)
		}
		if out, err := hostOutput("zfs", args...); err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				f := strings.Split(line, "\t")
				if len(f) < 3 {
					continue
				}
				v := strings.TrimSpace(f[2])
				switch {
				case f[1] == "clones" && v != "" && v != "-":
					return nil, &fsError{Code: "EBUSY", Message: f[0] + " has clones (" + v + "): delete or promote them before rolling back"}
				case f[1] == "userrefs" && v != "" && v != "0" && v != "-":
					return nil, &fsError{Code: "EBUSY", Message: f[0] + " has a hold (zfs holds " + f[0] + "): release it before rolling back"}
				}
			}
		}
	}
	// Bookmarks made after the snapshot go too.
	marks := []string{}
	if out, err := hostOutput("zfs", "list", "-Hp", "-t", "bookmark", "-o", "name,creation", "-d", "1", target.Dataset); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			f := strings.Split(strings.TrimSpace(line), "\t")
			if len(f) == 2 && atoi64(f[1]) > target.Created {
				marks = append(marks, f[0][strings.LastIndex(f[0], "#"):])
			}
		}
	}
	summary := "Roll " + target.Dataset + " back to " + target.Short + ": every change made since is lost"
	if len(newer) > 0 {
		summary += ", and the newer snapshots are deleted: " + strings.Join(newer, ", ")
	}
	if len(marks) > 0 {
		summary += "; newer bookmarks are deleted too: " + strings.Join(marks, ", ")
	}
	step := cmdStep(target.Dataset, summary, []string{"zfs", "rollback", "-r", target.Name})
	step.Destructive = true
	return &opPlan{Op: "zfs.snapshot.rollback", Steps: []planStep{step}, Observed: map[string]string{"newer": strings.Join(newer, ",")}}, nil
}

func planZfsSnapshotRules(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Rules []snapRule `json:"rules"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	ds := zfsSnapshot().Datasets
	saved := map[snapRule]bool{}
	for _, r := range loadSnapRules() {
		saved[r] = true
	}
	seen := map[string]bool{}
	for _, r := range req.Rules {
		switch {
		// A rule of a dataset deleted since is kept as it was (it does nothing).
		case findDataset(ds, r.Dataset) == nil && !saved[r]:
			return nil, &fsError{Code: "ERR", Message: r.Dataset + " does not exist"}
		case !snapEvery[r.Every]:
			return nil, &fsError{Code: "ERR", Message: "invalid period " + r.Every}
		case r.Keep < 1 || r.Keep > 1000:
			return nil, &fsError{Code: "ERR", Message: "keep between 1 and 1000 snapshots"}
		case seen[r.Dataset+"@"+r.Every]:
			return nil, &fsError{Code: "ERR", Message: r.Dataset + " has two " + r.Every + " rules"}
		}
		seen[r.Dataset+"@"+r.Every] = true
	}
	if req.Rules == nil {
		req.Rules = []snapRule{}
	}
	before, readErr := os.ReadFile(zfsSnapshotRulesPath)
	kind := "update"
	if readErr != nil {
		kind = "create"
	}
	next := marshalSnapRules(req.Rules)
	step := planStep{Kind: kind, Target: zfsSnapshotRulesPath, Summary: "Save the scheduled snapshots",
		Diff: unifiedDiff(zfsSnapshotRulesPath, string(before), string(next)),
		run: func() (string, error) {
			if err := os.MkdirAll(filepath.Dir(zfsSnapshotRulesPath), 0o755); err != nil {
				return "", err
			}
			return "", writeFileAtomic(zfsSnapshotRulesPath, next, 0o644)
		}}
	return &opPlan{Op: "zfs.snapshot.rules", Steps: []planStep{step}, Observed: map[string]string{}}, nil
}

// snapDue: the latest scheduled snapshot of a rule is older than its period
// (5 minutes of slack, so an hourly timer never skips a beat).
func snapDue(every string, latest, now time.Time) bool {
	var next time.Time
	switch every {
	case "hourly":
		next = latest.Add(time.Hour)
	case "daily":
		next = latest.AddDate(0, 0, 1)
	case "weekly":
		next = latest.AddDate(0, 0, 7)
	default:
		next = latest.AddDate(0, 1, 0)
	}
	return !now.Before(next.Add(-5 * time.Minute))
}

// runZfsSnapshotRules takes the due scheduled snapshots and deletes the
// oldest ones beyond each rule's keep. Only snapshots named
// hsi-<every>-... of that dataset are ever deleted.
func runZfsSnapshotRules() []taskResult {
	rules := loadSnapRules()
	if len(rules) == 0 || !zfsAvailable() {
		return nil
	}
	all := listZfsSnapshots()
	ds := zfsSnapshot().Datasets
	now := zfsNow()
	results := []taskResult{}
	for _, r := range rules {
		if findDataset(ds, r.Dataset) == nil || !snapEvery[r.Every] || r.Keep < 1 {
			results = append(results, taskResult{Device: r.Dataset, Status: "skipped", Message: "the dataset is gone or the rule is invalid"})
			continue
		}
		prefix := "hsi-" + r.Every + "-"
		mine := []zfsSnap{}
		for _, s := range snapshotsOf(all, r.Dataset) {
			if strings.HasPrefix(s.Short, prefix) {
				mine = append(mine, s)
			}
		}
		sort.SliceStable(mine, func(i, j int) bool { return mine[i].Created < mine[j].Created })
		name := r.Dataset + "@" + prefix + now.Format("20060102-1504")
		taken := false
		for _, s := range mine {
			taken = taken || s.Name == name
		}
		if !taken && (len(mine) == 0 || snapDue(r.Every, time.Unix(mine[len(mine)-1].Created, 0), now)) {
			if out, err := runArgv([]string{"zfs", "snapshot", name}); err != nil {
				results = append(results, taskResult{Device: r.Dataset, Status: "error", Message: cmdErrMessage(out, err)})
				continue
			}
			mine = append(mine, zfsSnap{Name: name})
			results = append(results, taskResult{Device: name, Status: "started"})
		}
		for len(mine) > r.Keep {
			if out, err := runArgv([]string{"zfs", "destroy", mine[0].Name}); err != nil {
				results = append(results, taskResult{Device: mine[0].Name, Status: "error", Message: cmdErrMessage(out, err)})
			}
			mine = mine[1:]
		}
	}
	return results
}

func handleZfsSnapshots(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"snapshots": listZfsSnapshots(), "rules": loadSnapRules()})
}

func handleZfsSnapshotLs(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Snapshot string `json:"snapshot"`
		Path     string `json:"path"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	entries, truncated, fe := snapshotLs(req.Snapshot, req.Path)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"entries": entries, "truncated": truncated})
}
