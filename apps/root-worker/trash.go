package main

// Per-place trash (#200). A place with the trash on keeps deleted items in
// <place>/.hsi-trash, laid out like the freedesktop.org trash: files/<id> holds
// the item and info/<id>.trashinfo its original path, deletion date and who
// deleted it. The info file is written first, so an interrupted move leaves at
// worst an info file without an item, which listings skip and purges clean.
// Moving stays on one filesystem, so it is a rename: instant and atomic.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
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

func trashDirs(placeRoot string) (root, files, info string) {
	root = filepath.Join(placeRoot, trashDirName)
	return root, filepath.Join(root, "files"), filepath.Join(root, "info")
}

// validTrashID refuses anything that could leave the trash folders.
func validTrashID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, "/\x00") && len(id) <= 255
}

// ensureTrash creates the trash folders, group-writable and setgid like the
// place root, so every writer of the place can move items in and out.
func ensureTrash(placeRoot string) (files, info string, fe *fsError) {
	root, files, info := trashDirs(placeRoot)
	for _, d := range []string{root, files, info} {
		if err := os.Mkdir(d, 0o775|os.ModeSetgid); err != nil && !errors.Is(err, os.ErrExist) {
			return "", "", mapOsErr(err)
		}
		if fi, err := os.Lstat(d); err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
			return "", "", &fsError{Code: "ERR", Message: "the trash folder is not a folder"}
		}
		// Mkdir's mode is masked by the umask; set it as asked (owner only, best effort).
		_ = os.Chmod(d, 0o775|os.ModeSetgid)
	}
	return files, info, nil
}

// trashInside reports whether path is the trash itself or inside it.
func trashInside(placeRoot, path string) bool {
	root, _, _ := trashDirs(placeRoot)
	return path == root || strings.HasPrefix(path, root+"/")
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

// doTrash moves path into its place's trash and returns the new entry.
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
	files, info, fe := ensureTrash(placeRoot)
	if fe != nil {
		return nil, fe
	}
	base := filepath.Base(path)
	content := encodeTrashInfo(path, now, deletedBy)
	// Reserve a free id by creating its info file exclusively.
	var id string
	for n := 1; n < 10000; n++ {
		candidate := base
		if n > 1 {
			candidate = base + "." + strconv.Itoa(n)
		}
		f, err := os.OpenFile(filepath.Join(info, candidate+trashInfoExt), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o664)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, mapOsErr(err)
		}
		_, werr := f.WriteString(content)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = os.Remove(filepath.Join(info, candidate+trashInfoExt))
			return nil, &fsError{Code: "ERR", Message: "could not record the trash entry"}
		}
		if _, err := os.Lstat(filepath.Join(files, candidate)); err == nil {
			// A leftover item without its info: keep it, try the next id.
			_ = os.Remove(filepath.Join(info, candidate+trashInfoExt))
			continue
		}
		id = candidate
		break
	}
	if id == "" {
		return nil, &fsError{Code: "ERR", Message: "too many items with this name in the trash"}
	}
	if err := os.Rename(path, filepath.Join(files, id)); err != nil {
		_ = os.Remove(filepath.Join(info, id+trashInfoExt))
		if errors.Is(err, syscall.EXDEV) {
			return nil, &fsError{Code: "EXDEV", Message: "this item is on another volume than its place: delete it permanently instead"}
		}
		return nil, mapOsErr(err)
	}
	return entryFor(files, id, trashInfo{Path: path, DeletedAt: now, DeletedBy: deletedBy}, fi), nil
}

func entryFor(files, id string, ti trashInfo, fi os.FileInfo) *trashEntry {
	e := &trashEntry{
		ID: id, Name: filepath.Base(ti.Path), OriginalPath: ti.Path,
		DeletedAt: ti.DeletedAt.UTC().Format(time.RFC3339), DeletedBy: ti.DeletedBy, Type: "file",
	}
	if fi == nil {
		var err error
		if fi, err = os.Lstat(filepath.Join(files, id)); err != nil {
			return e
		}
	}
	if fi.IsDir() {
		e.Type = "dir"
	} else {
		sz := fi.Size()
		e.Size = &sz
	}
	return e
}

func readTrashInfo(info, id string) (trashInfo, *fsError) {
	data, err := os.ReadFile(filepath.Join(info, id+trashInfoExt))
	if err != nil {
		return trashInfo{}, mapOsErr(err)
	}
	ti, err := parseTrashInfo(string(data))
	if err != nil {
		return trashInfo{}, &fsError{Code: "ERR", Message: err.Error()}
	}
	return ti, nil
}

// doTrashList lists the trash of a place, newest first. A missing trash is empty.
func doTrashList(placeRoot string) ([]trashEntry, *fsError) {
	_, files, info := trashDirs(filepath.Clean(placeRoot))
	names, err := os.ReadDir(info)
	if errors.Is(err, os.ErrNotExist) {
		return []trashEntry{}, nil
	}
	if err != nil {
		return nil, mapOsErr(err)
	}
	out := []trashEntry{}
	for _, d := range names {
		id, ok := strings.CutSuffix(d.Name(), trashInfoExt)
		if !ok || !validTrashID(id) {
			continue
		}
		ti, fe := readTrashInfo(info, id)
		if fe != nil {
			continue
		}
		fi, err := os.Lstat(filepath.Join(files, id))
		if err != nil {
			continue // interrupted move: no item behind this info
		}
		out = append(out, *entryFor(files, id, ti, fi))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt > out[j].DeletedAt })
	return out, nil
}

// doTrashRestore puts an item back where it was, or at target when given.
// It never overwrites: a taken destination is EEXIST and the item stays.
func doTrashRestore(placeRoot, id, target string) (string, *fsError) {
	placeRoot = filepath.Clean(placeRoot)
	if !validTrashID(id) {
		return "", &fsError{Code: "ERR", Message: "invalid trash item"}
	}
	_, files, info := trashDirs(placeRoot)
	ti, fe := readTrashInfo(info, id)
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
	if _, err := os.Lstat(dst); err == nil {
		return "", &fsError{Code: "EEXIST", Message: "something already exists at " + dst}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o775|os.ModeSetgid); err != nil {
		return "", mapOsErr(err)
	}
	if err := os.Rename(filepath.Join(files, id), dst); err != nil {
		return "", mapOsErr(err)
	}
	_ = os.Remove(filepath.Join(info, id+trashInfoExt))
	return dst, nil
}

// doTrashDelete removes items for good; no ids empties the trash.
func doTrashDelete(placeRoot string, ids []string) *fsError {
	_, files, info := trashDirs(filepath.Clean(placeRoot))
	if len(ids) == 0 {
		names, err := os.ReadDir(info)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return mapOsErr(err)
		}
		for _, d := range names {
			if id, ok := strings.CutSuffix(d.Name(), trashInfoExt); ok {
				ids = append(ids, id)
			}
		}
		// Items left without an info file go too.
		if items, err := os.ReadDir(files); err == nil {
			for _, d := range items {
				ids = append(ids, d.Name())
			}
		}
	}
	for _, id := range ids {
		if !validTrashID(id) {
			return &fsError{Code: "ERR", Message: "invalid trash item"}
		}
		if err := os.RemoveAll(filepath.Join(files, id)); err != nil {
			return mapOsErr(err)
		}
		if err := os.Remove(filepath.Join(info, id+trashInfoExt)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return mapOsErr(err)
		}
	}
	return nil
}

// doTrashPurge removes items deleted before cutoff, and info files whose item
// is gone. It returns how many items it removed.
func doTrashPurge(placeRoot string, cutoff time.Time) (int, *fsError) {
	_, files, info := trashDirs(filepath.Clean(placeRoot))
	names, err := os.ReadDir(info)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, mapOsErr(err)
	}
	removed := 0
	for _, d := range names {
		id, ok := strings.CutSuffix(d.Name(), trashInfoExt)
		if !ok || !validTrashID(id) {
			continue
		}
		ti, fe := readTrashInfo(info, id)
		_, statErr := os.Lstat(filepath.Join(files, id))
		orphan := errors.Is(statErr, os.ErrNotExist)
		if fe == nil && !orphan && !ti.DeletedAt.Before(cutoff) {
			continue
		}
		if fe != nil && !orphan {
			continue // unreadable info for a present item: leave it for a person to decide
		}
		if err := doTrashDelete(placeRoot, []string{id}); err != nil {
			return removed, err
		}
		if !orphan {
			removed++
		}
	}
	return removed, nil
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
	if fe := rejectTrashSymlink(req.PlaceRoot); fe != nil {
		replyErr(nc, msg.Reply, fe)
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
			if dst, fsErr = doTrashRestore(req.PlaceRoot, req.IDs[0], req.Target); fsErr == nil {
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
			fsErr = doTrashDelete(req.PlaceRoot, nil)
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

// rejectTrashSymlink refuses a trash folder that is a symlink, which would
// send moves and removals somewhere else.
func rejectTrashSymlink(placeRoot string) *fsError {
	root, files, info := trashDirs(filepath.Clean(placeRoot))
	for _, d := range []string{root, files, info} {
		if fi, err := os.Lstat(d); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			return &fsError{Code: "ERR", Message: "the trash folder is a symlink"}
		}
	}
	return nil
}
