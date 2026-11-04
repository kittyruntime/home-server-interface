package main

// Per-place trash (#200). A place with the trash on keeps deleted items in
// <place>/.hsi-trash/<uid>, one private folder per user (0700, the user's
// own): a file moved there keeps the protection its folders gave it, and only
// the user who deleted it (or root) can see, restore or remove it. Each folder
// is laid out like the freedesktop.org trash: files/<name> holds the item and
// info/<name>.trashinfo its original path, deletion date and who deleted it.
// The info file is written first, so an interrupted move leaves at worst an
// info file without an item, which listings skip and purges clean. Moving
// stays on one filesystem, so it is a rename: instant and atomic.
//
// An item's id is "<uid>:<name>". Moves and restores run as the user; root
// (the purge, an administrator) reaches every user's folder. Every removal
// goes through folders opened without following symlinks.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
	"golang.org/x/sys/unix"
)

const (
	trashDirName = ".hsi-trash"
	trashInfoExt = ".trashinfo"
	trashTimeFmt = "2006-01-02T15:04:05"
)

type trashEntry struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	OriginalPath string `json:"originalPath"`
	DeletedAt    string `json:"deletedAt"`
	DeletedBy    string `json:"deletedBy,omitempty"`
	Type         string `json:"type"`
	Size         *int64 `json:"size"`
}

func trashRoot(placeRoot string) string {
	return filepath.Join(filepath.Clean(placeRoot), trashDirName)
}

// userTrash is the folder of one user's trash in a place.
func userTrash(placeRoot, uid string) (dir, files, info string) {
	dir = filepath.Join(trashRoot(placeRoot), uid)
	return dir, filepath.Join(dir, "files"), filepath.Join(dir, "info")
}

func validUID(uid string) bool {
	if uid == "" || len(uid) > 10 {
		return false
	}
	for _, c := range uid {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// validTrashName refuses anything that could leave a trash folder.
func validTrashName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\x00") && len(name) <= 255
}

// splitTrashID splits "<uid>:<name>".
func splitTrashID(id string) (uid, name string, ok bool) {
	uid, name, ok = strings.Cut(id, ":")
	return uid, name, ok && validUID(uid) && validTrashName(name)
}

func currentUID() string { return strconv.Itoa(unix.Geteuid()) }

// trashInside reports whether path is the trash itself or inside it.
func trashInside(placeRoot, path string) bool {
	root := trashRoot(placeRoot)
	return path == root || strings.HasPrefix(path, root+"/")
}

// The shared top folder, <place>/.hsi-trash, is root's and 0755, so only root
// makes entries in it; each user's folder and its files/ and info/ are that
// user's and 0700. Every operation opens this chain once without following a
// symlink and checks each link's owner and mode on the opened folder, then
// works relative to those folders: renaming or replacing a folder afterwards
// (the place root is writable by its writers) changes nothing.

// trashTopOwner owns the shared top trash folder: root, except in tests,
// which cannot chown.
var trashTopOwner = "0"

func fdOwner(fd int) (uid string, perm uint32, ok bool) {
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return "", 0, false
	}
	return strconv.FormatUint(uint64(st.Uid), 10), st.Mode & 0o7777, true
}

// openOwnedDir opens name under dirfd, a real folder owned by owner with
// exactly mode, or fails.
func openOwnedDir(dirfd int, name, owner string, mode uint32) (int, *fsError) {
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, mapOsErr(err)
	}
	if uid, perm, ok := fdOwner(fd); !ok || uid != owner || perm != mode {
		unix.Close(fd)
		return -1, &fsError{Code: "EACCES", Message: "a trash folder is not as HSI made it"}
	}
	return fd, nil
}

// trashFds opens and checks one user's trash; ok is false when it does not
// exist (yet).
func trashFds(placeRoot, uid string) (files, info int, ok bool, fe *fsError) {
	if !validUID(uid) {
		return -1, -1, false, &fsError{Code: "ERR", Message: "invalid trash"}
	}
	placeFd, err := openTrashDir(filepath.Clean(placeRoot))
	if err != nil {
		return -1, -1, false, mapOsErr(err)
	}
	defer unix.Close(placeFd)
	topFd, fe := openOwnedDir(placeFd, trashDirName, trashTopOwner, 0o755)
	if fe != nil {
		if fe.Code == "ENOENT" {
			return -1, -1, false, nil
		}
		return -1, -1, false, fe
	}
	defer unix.Close(topFd)
	userFd, fe := openOwnedDir(topFd, uid, uid, 0o700)
	if fe != nil {
		if fe.Code == "ENOENT" {
			return -1, -1, false, nil
		}
		return -1, -1, false, fe
	}
	defer unix.Close(userFd)
	ffd, fe := openOwnedDir(userFd, "files", uid, 0o700)
	if fe != nil {
		return -1, -1, false, fe
	}
	ifd, fe := openOwnedDir(userFd, "info", uid, 0o700)
	if fe != nil {
		unix.Close(ffd)
		return -1, -1, false, fe
	}
	return ffd, ifd, true, nil
}

// prepareUserTrash, run as root before a move, makes the user's trash. It
// never takes over a folder someone else made: a top folder that is not
// root's 0755 is set aside and made again, and a user's folder owned by
// anyone but that user (or root, half made by an earlier call) is refused.
func prepareUserTrash(placeRoot string, owner userCtx) *fsError {
	uidN, okU := toUint32(owner.uid)
	gidN, okG := toUint32(owner.gid)
	if !okU || !okG {
		return &fsError{Code: "ERR", Message: "invalid owner for the trash"}
	}
	uid := strconv.FormatUint(uint64(uidN), 10)
	placeFd, err := openTrashDir(filepath.Clean(placeRoot))
	if err != nil {
		return mapOsErr(err)
	}
	defer unix.Close(placeFd)

	topFd, fe := openOwnedDir(placeFd, trashDirName, trashTopOwner, 0o755)
	if fe != nil && fe.Code != "ENOENT" {
		// Not ours: set it aside, untouched, and start a new one.
		aside := fmt.Sprintf("%s.set-aside-%d", trashDirName, time.Now().UnixNano())
		if err := unix.Renameat(placeFd, trashDirName, placeFd, aside); err != nil {
			return mapOsErr(err)
		}
		fe = &fsError{Code: "ENOENT"}
	}
	if fe != nil {
		if err := unix.Mkdirat(placeFd, trashDirName, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			return mapOsErr(err)
		}
		fd, err := unix.Openat(placeFd, trashDirName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return mapOsErr(err)
		}
		if o, _, ok := fdOwner(fd); !ok || o != trashTopOwner || unix.Fchmod(fd, 0o755) != nil {
			unix.Close(fd)
			return &fsError{Code: "EACCES", Message: "could not make the trash folder"}
		}
		topFd = fd
	}
	defer unix.Close(topFd)

	userFd, fe := userDirAt(topFd, uid, uidN, gidN)
	if fe != nil {
		return fe
	}
	defer unix.Close(userFd)
	for _, sub := range []string{"files", "info"} {
		fd, fe := userDirAt(userFd, sub, uidN, gidN)
		if fe != nil {
			return fe
		}
		unix.Close(fd)
	}
	return nil
}

// userDirAt makes name under dirfd the user's 0700 folder: created and handed
// over when missing, kept when already theirs, taken over only from root.
func userDirAt(dirfd int, name string, uid, gid uint32) (int, *fsError) {
	if err := unix.Mkdirat(dirfd, name, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		return -1, mapOsErr(err)
	}
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, &fsError{Code: "ERR", Message: "the trash folder is not a folder"}
	}
	owner, _, ok := fdOwner(fd)
	want := strconv.FormatUint(uint64(uid), 10)
	if !ok || (owner != want && owner != "0") {
		unix.Close(fd)
		return -1, &fsError{Code: "EACCES", Message: "this trash folder belongs to someone else"}
	}
	if owner != want {
		// Only a folder an earlier call made and left empty is handed over.
		if names, err := dirNames(fd); err != nil || len(names) > 0 {
			unix.Close(fd)
			return -1, &fsError{Code: "EACCES", Message: "a trash folder is not as HSI made it"}
		}
		if err := unix.Fchown(fd, int(uid), int(gid)); err != nil {
			unix.Close(fd)
			return -1, mapOsErr(err)
		}
	}
	if err := unix.Fchmod(fd, 0o700); err != nil {
		unix.Close(fd)
		return -1, mapOsErr(err)
	}
	return fd, nil
}

func encodeTrashInfo(original string, at time.Time, by string) string {
	u := url.URL{Path: original}
	var b strings.Builder
	b.WriteString("[Trash Info]\n")
	b.WriteString("Path=" + u.EscapedPath() + "\n")
	b.WriteString("DeletionDate=" + at.Format(trashTimeFmt) + "\n")
	if by != "" {
		b.WriteString("X-HSI-DeletedBy=" + url.QueryEscape(by) + "\n")
	}
	return b.String()
}

type trashInfo struct {
	Path      string
	DeletedAt time.Time
	DeletedBy string
}

func parseTrashInfo(data string) (trashInfo, error) {
	var ti trashInfo
	sc := bufio.NewScanner(strings.NewReader(data))
	header := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "[Trash Info]" {
			header = true
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || !header {
			continue
		}
		switch key {
		case "Path":
			p, err := url.PathUnescape(value)
			if err != nil {
				return ti, err
			}
			ti.Path = p
		case "DeletionDate":
			t, err := time.ParseInLocation(trashTimeFmt, value, time.Local)
			if err != nil {
				return ti, err
			}
			ti.DeletedAt = t
		case "X-HSI-DeletedBy":
			if by, err := url.QueryUnescape(value); err == nil {
				ti.DeletedBy = by
			}
		}
	}
	if !header || ti.Path == "" || ti.DeletedAt.IsZero() {
		return ti, errors.New("not a trash info file")
	}
	return ti, nil
}

// doTrash moves path into the calling user's trash in its place.
func doTrash(placeRoot, path, deletedBy string, now time.Time) (*trashEntry, *fsError) {
	placeRoot = filepath.Clean(placeRoot)
	path = filepath.Clean(path)
	if path == placeRoot || !strings.HasPrefix(path, placeRoot+"/") {
		return nil, &fsError{Code: "EACCES", Message: "only items inside a place go to its trash"}
	}
	if trashInside(placeRoot, path) {
		return nil, &fsError{Code: "ERR", Message: "items already in the trash are deleted permanently"}
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, mapOsErr(err)
	}
	uid := currentUID()
	files, info, ok, fe := trashFds(placeRoot, uid)
	if fe != nil {
		return nil, fe
	}
	if !ok {
		return nil, &fsError{Code: "ERR", Message: "the trash of this place is not ready"}
	}
	defer unix.Close(files)
	defer unix.Close(info)
	base := filepath.Base(path)
	content := encodeTrashInfo(path, now, deletedBy)
	// Reserve a free name by creating its info file exclusively.
	var name string
	for n := 1; n < 10000; n++ {
		candidate := base
		if n > 1 {
			candidate = base + "." + strconv.Itoa(n)
		}
		fd, err := unix.Openat(info, candidate+trashInfoExt, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
		if errors.Is(err, unix.EEXIST) {
			continue
		}
		if err != nil {
			return nil, mapOsErr(err)
		}
		f := os.NewFile(uintptr(fd), candidate+trashInfoExt)
		_, werr := f.WriteString(content)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = unix.Unlinkat(info, candidate+trashInfoExt, 0)
			return nil, &fsError{Code: "ERR", Message: "could not record the trash entry"}
		}
		if _, err := lstatAt(files, candidate); err == nil {
			// A leftover item without its info: keep it, try the next name.
			_ = unix.Unlinkat(info, candidate+trashInfoExt, 0)
			continue
		}
		name = candidate
		break
	}
	if name == "" {
		return nil, &fsError{Code: "ERR", Message: "too many items with this name in the trash"}
	}
	if err := unix.Renameat2(unix.AT_FDCWD, path, files, name, unix.RENAME_NOREPLACE); err != nil {
		_ = unix.Unlinkat(info, name+trashInfoExt, 0)
		if errors.Is(err, unix.EXDEV) {
			return nil, &fsError{Code: "EXDEV", Message: "this item is on another volume than its place: delete it permanently instead"}
		}
		return nil, mapOsErr(err)
	}
	return entryFor(uid, name, trashInfo{Path: path, DeletedAt: now, DeletedBy: deletedBy}, fi), nil
}

func entryFor(uid, name string, ti trashInfo, fi os.FileInfo) *trashEntry {
	e := &trashEntry{
		ID: uid + ":" + name, Name: filepath.Base(ti.Path), OriginalPath: ti.Path,
		DeletedAt: ti.DeletedAt.UTC().Format(time.RFC3339), DeletedBy: ti.DeletedBy, Type: "file",
	}
	if fi.IsDir() {
		e.Type = "dir"
	} else {
		sz := fi.Size()
		e.Size = &sz
	}
	return e
}

// trashUIDs lists whose trash folders the caller reaches: its own, or every
// one when it runs as root.
func trashUIDs(placeRoot string) ([]string, *fsError) {
	uid := currentUID()
	if uid != "0" {
		return []string{uid}, nil
	}
	fd, err := openTrashDir(trashRoot(placeRoot))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, mapOsErr(err)
	}
	defer unix.Close(fd)
	names, err := dirNames(fd)
	if err != nil {
		return nil, mapOsErr(err)
	}
	out := []string{}
	for _, n := range names {
		if validUID(n) {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out, nil
}

// doTrashList lists the trash the caller reaches in a place, newest first.
func doTrashList(placeRoot string) ([]trashEntry, *fsError) {
	uids, fe := trashUIDs(placeRoot)
	if fe != nil {
		return nil, fe
	}
	out := []trashEntry{}
	for _, uid := range uids {
		files, info, ok, fe := trashFds(placeRoot, uid)
		if fe != nil {
			if fe.Code == "EACCES" {
				continue
			}
			return nil, fe
		}
		if !ok {
			continue
		}
		if names, err := dirNames(info); err == nil {
			for _, n := range names {
				name, ok := strings.CutSuffix(n, trashInfoExt)
				if !ok || !validTrashName(name) {
					continue
				}
				ti, fe := readTrashInfoAt(info, name)
				if fe != nil {
					continue
				}
				fi, err := lstatAt(files, name)
				if err != nil {
					continue // interrupted move: no item behind this info
				}
				out = append(out, *entryFor(uid, name, ti, fi))
			}
		}
		unix.Close(files)
		unix.Close(info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt > out[j].DeletedAt })
	return out, nil
}

// doTrashRestore puts an item back at target, or where it was when target is
// empty. It never overwrites: a taken destination is EEXIST and the item stays.
func doTrashRestore(placeRoot, id, target string) (string, *fsError) {
	placeRoot = filepath.Clean(placeRoot)
	uid, name, ok := splitTrashID(id)
	if !ok {
		return "", &fsError{Code: "ERR", Message: "invalid trash item"}
	}
	files, info, present, fe := trashFds(placeRoot, uid)
	if fe != nil {
		return "", fe
	}
	if !present {
		return "", &fsError{Code: "ENOENT", Message: "this item is no longer in the trash"}
	}
	defer unix.Close(files)
	defer unix.Close(info)
	ti, fe := readTrashInfoAt(info, name)
	if fe != nil {
		return "", fe
	}
	dst := filepath.Clean(ti.Path)
	if target != "" {
		dst = filepath.Clean(target)
	}
	if dst == placeRoot || !strings.HasPrefix(dst, placeRoot+"/") || trashInside(placeRoot, dst) {
		return "", &fsError{Code: "EACCES", Message: "an item is restored inside its place"}
	}
	// The info file names a path chosen at deletion: never follow a symlink
	// that appeared on the way since.
	if err := rejectSymlinkComponents(placeRoot, dst); err != nil {
		return "", &fsError{Code: "EACCES", Message: "the destination goes through a symlink"}
	}
	if _, err := os.Lstat(dst); err == nil {
		return "", &fsError{Code: "EEXIST", Message: "something already exists at " + dst}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o775|os.ModeSetgid); err != nil {
		return "", mapOsErr(err)
	}
	// RENAME_NOREPLACE: something that appeared since the check is never overwritten.
	if err := unix.Renameat2(files, name, unix.AT_FDCWD, dst, unix.RENAME_NOREPLACE); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return "", &fsError{Code: "EEXIST", Message: "something already exists at " + dst}
		}
		return "", mapOsErr(err)
	}
	_ = unix.Unlinkat(info, name+trashInfoExt, 0)
	return dst, nil
}

// doTrashDelete removes the given items for good.
func doTrashDelete(placeRoot string, ids []string) *fsError {
	for _, id := range ids {
		uid, name, ok := splitTrashID(id)
		if !ok {
			return &fsError{Code: "ERR", Message: "invalid trash item"}
		}
		if fe := removeTrashItems(placeRoot, uid, []string{name}); fe != nil {
			return fe
		}
	}
	return nil
}

// doTrashEmpty empties the trash the caller reaches: its own, or all as root.
func doTrashEmpty(placeRoot string) *fsError {
	uids, fe := trashUIDs(placeRoot)
	if fe != nil {
		return fe
	}
	for _, uid := range uids {
		if fe := removeTrashItems(placeRoot, uid, nil); fe != nil {
			return fe
		}
	}
	return nil
}

// removeTrashItems removes names from one user's trash; nil means all of it,
// items left without an info file included.
func removeTrashItems(placeRoot, uid string, names []string) *fsError {
	files, info, ok, fe := trashFds(placeRoot, uid)
	if fe != nil || !ok {
		return fe
	}
	defer unix.Close(files)
	defer unix.Close(info)
	if names == nil {
		infos, err := dirNames(info)
		if err != nil {
			return mapOsErr(err)
		}
		for _, n := range infos {
			if name, ok := strings.CutSuffix(n, trashInfoExt); ok {
				names = append(names, name)
			}
		}
		if items, err := dirNames(files); err == nil {
			names = append(names, items...)
		}
	}
	for _, name := range names {
		if !validTrashName(name) {
			return &fsError{Code: "ERR", Message: "invalid trash item"}
		}
		if err := removeAllAt(files, name); err != nil {
			return mapOsErr(err)
		}
		if err := unix.Unlinkat(info, name+trashInfoExt, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return mapOsErr(err)
		}
	}
	return nil
}

// doTrashPurge removes items deleted before cutoff, and info files whose item
// is gone, in every trash the caller reaches. It returns how many items went.
func doTrashPurge(placeRoot string, cutoff time.Time) (int, *fsError) {
	uids, fe := trashUIDs(placeRoot)
	if fe != nil {
		return 0, fe
	}
	removed := 0
	for _, uid := range uids {
		n, fe := purgeUser(placeRoot, uid, cutoff)
		removed += n
		if fe != nil {
			return removed, fe
		}
	}
	return removed, nil
}

func purgeUser(placeRoot, uid string, cutoff time.Time) (int, *fsError) {
	files, info, ok, fe := trashFds(placeRoot, uid)
	if fe != nil || !ok {
		return 0, fe
	}
	defer unix.Close(files)
	defer unix.Close(info)
	names, err := dirNames(info)
	if err != nil {
		return 0, mapOsErr(err)
	}
	removed := 0
	for _, n := range names {
		name, ok := strings.CutSuffix(n, trashInfoExt)
		if !ok || !validTrashName(name) {
			continue
		}
		ti, fe := readTrashInfoAt(info, name)
		_, statErr := lstatAt(files, name)
		orphan := errors.Is(statErr, unix.ENOENT)
		if fe == nil && !orphan && !ti.DeletedAt.Before(cutoff) {
			continue
		}
		if fe != nil && !orphan {
			continue // unreadable info for a present item: leave it for a person to decide
		}
		if err := removeAllAt(files, name); err != nil {
			return removed, mapOsErr(err)
		}
		if err := unix.Unlinkat(info, name+trashInfoExt, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return removed, mapOsErr(err)
		}
		if !orphan {
			removed++
		}
	}
	return removed, nil
}

// restoreAsOwner restores as the item's owner even when root asks (an
// administrator): the destination comes from an info file the owner can
// edit, so the move only goes where the owner itself may write.
func restoreAsOwner(placeRoot, id, target string) (string, *fsError) {
	uid, _, ok := splitTrashID(id)
	if !ok {
		return "", &fsError{Code: "ERR", Message: "invalid trash item"}
	}
	if currentUID() != "0" || uid == "0" {
		return doTrashRestore(placeRoot, id, target)
	}
	u, err := user.LookupId(uid)
	if err != nil {
		return "", &fsError{Code: "ERR", Message: "the owner of this item no longer exists"}
	}
	owner, err := resolveUser(u.Username)
	if err != nil {
		return "", &fsError{Code: "ERR", Message: err.Error()}
	}
	var dst string
	var fe *fsError
	if err := runAsUser(owner, func() error {
		dst, fe = doTrashRestore(placeRoot, id, target)
		return nil
	}); err != nil {
		return "", toFsErr(err)
	}
	return dst, fe
}

// ── NATS handler ─────────────────────────────────────────────────────────────

type trashReq struct {
	LinuxUsername string   `json:"linuxUsername"`
	Op            string   `json:"op"`
	PlaceRoot     string   `json:"placeRoot"`
	Path          string   `json:"path"`
	DeletedBy     string   `json:"deletedBy"`
	IDs           []string `json:"ids"`
	Target        string   `json:"target"`
	OlderThanDays int      `json:"olderThanDays"`
}

// trashSlots runs trash requests off the subscription goroutine, a few at a
// time: emptying a large trash must not hold up a move into another one.
var trashSlots = make(chan struct{}, 4)

func handleTrash(nc *nats.Conn, msg *nats.Msg) {
	trashSlots <- struct{}{}
	go func() {
		defer func() { <-trashSlots }()
		runTrash(nc, msg)
	}()
}

func runTrash(nc *nats.Conn, msg *nats.Msg) {
	var req trashReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := validatePath(req.PlaceRoot); err != nil || filepath.Clean(req.PlaceRoot) == "/" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid place"})
		return
	}
	var result interface{}
	var fsErr *fsError
	run := func() error {
		switch req.Op {
		case "trash":
			if fsErr = validateScoped(req.Path, req.PlaceRoot); fsErr == nil {
				result, fsErr = doTrash(req.PlaceRoot, req.Path, req.DeletedBy, time.Now())
			}
		case "list":
			result, fsErr = doTrashList(req.PlaceRoot)
		case "restore":
			if len(req.IDs) != 1 {
				fsErr = &fsError{Code: "ERR", Message: "restore one item at a time"}
				break
			}
			var dst string
			if dst, fsErr = restoreAsOwner(req.PlaceRoot, req.IDs[0], req.Target); fsErr == nil {
				result = map[string]string{"path": dst}
			}
		case "delete":
			if len(req.IDs) == 0 {
				fsErr = &fsError{Code: "ERR", Message: "no items given"}
				break
			}
			fsErr = doTrashDelete(req.PlaceRoot, req.IDs)
			result = map[string]bool{"ok": true}
		case "empty":
			fsErr = doTrashEmpty(req.PlaceRoot)
			result = map[string]bool{"ok": true}
		case "purge":
			if req.OlderThanDays < 1 {
				fsErr = &fsError{Code: "ERR", Message: "a purge needs a number of days"}
				break
			}
			var n int
			n, fsErr = doTrashPurge(req.PlaceRoot, time.Now().AddDate(0, 0, -req.OlderThanDays))
			result = map[string]int{"removed": n}
		default:
			fsErr = &fsError{Code: "ERR", Message: fmt.Sprintf("unknown trash operation %q", req.Op)}
		}
		return nil
	}
	if req.Op == "trash" {
		owner, err := resolveUserCtx(req.LinuxUsername)
		if err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
			return
		}
		if fe := prepareUserTrash(req.PlaceRoot, owner); fe != nil {
			replyErr(nc, msg.Reply, fe)
			return
		}
	}
	if err := withUser(req.LinuxUsername, run); err != nil {
		replyErr(nc, msg.Reply, toFsErr(err))
		return
	}
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, result)
}

// ── symlink-proof access ─────────────────────────────────────────────────────
// Trash folders sit inside folders place writers can change. They are opened
// without following any symlink, and every read and removal is relative to
// them, never following one either: swapping a folder for a link between a
// check and a removal can only make the removal fail.

func openTrashDir(path string) (int, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_NO_SYMLINKS,
	})
	if errors.Is(err, unix.ENOSYS) {
		if real, rerr := filepath.EvalSymlinks(path); rerr != nil || real != path {
			return -1, &os.PathError{Op: "open", Path: path, Err: unix.ELOOP}
		}
		fd, err = unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	}
	if err != nil {
		return -1, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return fd, nil
}

// removeAllAt removes name under dirfd and everything inside it.
func removeAllAt(dirfd int, name string) error {
	err := unix.Unlinkat(dirfd, name, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) {
		return err
	}
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(fd), name)
	names, rerr := dir.Readdirnames(-1)
	if rerr == nil {
		for _, n := range names {
			if err := removeAllAt(fd, n); err != nil {
				dir.Close()
				return err
			}
		}
	}
	dir.Close()
	if rerr != nil {
		return rerr
	}
	return unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR)
}

// lstatAt stats name under dirfd without following a symlink.
func lstatAt(dirfd int, name string) (os.FileInfo, error) {
	fd, err := unix.Openat(dirfd, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	return f.Stat()
}

// readTrashInfoAt reads an info file relative to the info folder, refusing a symlink.
func readTrashInfoAt(infoFd int, name string) (trashInfo, *fsError) {
	fd, err := unix.Openat(infoFd, name+trashInfoExt, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return trashInfo{}, mapOsErr(err)
	}
	f := os.NewFile(uintptr(fd), name+trashInfoExt)
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() || fi.Size() > 64*1024 {
		return trashInfo{}, &fsError{Code: "ERR", Message: "not a trash info file"}
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return trashInfo{}, mapOsErr(err)
	}
	ti, perr := parseTrashInfo(string(data))
	if perr != nil {
		return trashInfo{}, &fsError{Code: "ERR", Message: perr.Error()}
	}
	return ti, nil
}

func dirNames(fd int) ([]string, error) {
	dup, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	d := os.NewFile(uintptr(dup), "trash")
	defer d.Close()
	return d.Readdirnames(-1)
}
