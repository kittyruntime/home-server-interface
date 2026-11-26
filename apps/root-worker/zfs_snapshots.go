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
	Kind  string `json:"kind"` // dir, file, link, other
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
}

const maxSnapEntries = 5000

// snapshotLs lists a folder of a snapshot, never following a link.
func snapshotLs(snapshot, p string) ([]snapEntry, *fsError) {
	rel, ok := cleanSnapPath(p)
	if !ok {
		return nil, &fsError{Code: "ERR", Message: "invalid path"}
	}
	mount, fe := snapshotMount(snapshot)
	if fe != nil {
		return nil, fe
	}
	_, short, _ := splitSnapshot(snapshot)
	fd, err := openNoLinks(filepath.Join(mount, ".zfs", "snapshot", short), rel)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: "cannot open " + p + " in the snapshot (a link or not a folder)"}
	}
	dir := os.NewFile(uintptr(fd), "snapshot")
	defer dir.Close()
	names, _ := dir.Readdirnames(maxSnapEntries) // io.EOF on an empty folder
	sort.Strings(names)
	entries := []snapEntry{}
	for _, n := range names {
		var st unix.Stat_t
		if unix.Fstatat(fd, n, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		kind := "other"
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
	return entries, nil
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
	name := restoredName(base, st.Mode&unix.S_IFMT == unix.S_IFDIR, zfsNow())
	var dst unix.Stat_t
	exists := unix.Fstatat(dfd, name, &dst, unix.AT_SYMLINK_NOFOLLOW) == nil
	unix.Close(dfd)
	if exists {
		return nil, &fsError{Code: "EEXIST", Message: filepath.Join(mount, parentRel, name) + " already exists"}
	}
	src := filepath.Join(snapRoot, rel)
	target := filepath.Join(mount, parentRel, name)
	step := planStep{Kind: "create", Target: target,
		Summary: "Copy " + req.Path + " from the snapshot " + short + " next to the original, as " + name,
		Command: []string{"cp", "-a", "--reflink=auto", "--", src, target},
		run: func() (string, error) {
			return "", restoreFromSnapshot(mount, parentRel, src, name)
		}}
	return &opPlan{Op: "zfs.snapshot.restore", Steps: []planStep{step}, Observed: map[string]string{"target": target}}, nil
}

// restoreFromSnapshot copies src into a folder only root can write, created
// inside the destination folder held open, then moves it in place without
// replacing anything: a folder swapped for a link meanwhile changes nothing.
func restoreFromSnapshot(mount, parentRel, src, name string) error {
	dfd, err := openNoLinks(mount, parentRel)
	if err != nil {
		return errors.New("the destination folder changed: " + err.Error())
	}
	defer unix.Close(dfd)
	tmp := ".hsi-restore-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := unix.Mkdirat(dfd, tmp, 0o700); err != nil {
		return err
	}
	defer func() {
		_, _ = runArgv([]string{"rm", "-rf", "--one-file-system", "--", "/proc/" + strconv.Itoa(os.Getpid()) + "/fd/" + strconv.Itoa(dfd) + "/" + tmp})
		_ = unix.Unlinkat(dfd, tmp, unix.AT_REMOVEDIR)
	}()
	into := "/proc/" + strconv.Itoa(os.Getpid()) + "/fd/" + strconv.Itoa(dfd) + "/" + tmp + "/x"
	if out, err := copyArgv([]string{"cp", "-a", "--reflink=auto", "--", src, into}); err != nil {
		return cmdError{cmdErrMessage(out, err)}
	}
	if err := unix.Renameat2(dfd, tmp+"/x", dfd, name, unix.RENAME_NOREPLACE); err != nil {
		return errors.New("could not put " + name + " in place: " + err.Error())
	}
	return nil
}

// copyArgv runs the copy of a restore (tests keep the real one).
var copyArgv = func(argv []string) ([]byte, error) {
	return command(argv[0], argv[1:]...).CombinedOutput()
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
	name := req.Dataset + "@hsi-manual-" + zfsNow().Format("20060102-150405")
	return &opPlan{Op: "zfs.snapshot.create", Steps: []planStep{
		cmdStep(name, "Take the snapshot "+name, []string{"zfs", "snapshot", name}),
	}, Observed: map[string]string{}}, nil
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
	summary := "Roll " + target.Dataset + " back to " + target.Short + ": every change made since is lost"
	if len(newer) > 0 {
		summary += ", and the newer snapshots are deleted: " + strings.Join(newer, ", ")
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
	seen := map[string]bool{}
	for _, r := range req.Rules {
		switch {
		case findDataset(ds, r.Dataset) == nil:
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
		if len(mine) == 0 || snapDue(r.Every, time.Unix(mine[len(mine)-1].Created, 0), now) {
			name := r.Dataset + "@" + prefix + now.Format("20060102-1504")
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
	entries, fe := snapshotLs(req.Snapshot, req.Path)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"entries": entries})
}
