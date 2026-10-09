package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

// ── Configuration backup v2 (#1) ─────────────────────────────────────────────
// The backend encrypts; the worker builds and reads the archive inside: the
// database and secrets the backend staged, plus what only root can read (the
// account ids, the app definitions, the storage descriptions, the maintenance
// schedule). Archives travel through a staging directory only the backend
// user and root can read.

const (
	backupMaxAppFile = 10 << 20
	backupMaxTotal   = 256 << 20
	backupMaxEntries = 20000
)

var (
	containersDir  = "/opt/containers"
	reAppDir       = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	hostLookupUser = func(name string) (int, int, bool) {
		u, err := user.Lookup(name)
		if err != nil {
			return 0, 0, false
		}
		uid, e1 := strconv.Atoi(u.Uid)
		gid, e2 := strconv.Atoi(u.Gid)
		return uid, gid, e1 == nil && e2 == nil
	}
	hostLookupGroup = func(name string) (int, bool) {
		g, err := user.LookupGroup(name)
		if err != nil {
			return 0, false
		}
		gid, err := strconv.Atoi(g.Gid)
		return gid, err == nil
	}
)

func backupStagingDir() string { return envOr("HSI_BACKUP_STAGING", "/var/lib/hsi/backup-staging") }

type backupItem struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type backupManifest struct {
	Format     int          `json:"format"`
	HSIVersion string       `json:"hsiVersion"`
	CreatedAt  string       `json:"createdAt"`
	Hostname   string       `json:"hostname"`
	Items      []backupItem `json:"items"`
}

type accountRec struct {
	Name string `json:"name"`
	UID  int    `json:"uid"`
	GID  int    `json:"gid"`
}

type groupRec struct {
	Name    string   `json:"name"`
	GID     int      `json:"gid"`
	Members []string `json:"members,omitempty"`
}

type accountsFile struct {
	Users  []accountRec `json:"users"`
	Groups []groupRec   `json:"groups"`
}

// inStaging tells whether p is under the staging root without going through
// a symlink: the backend owns the staging directory and could plant one
// pointing anywhere, and the worker reads and writes there as root.
func inStaging(p string) bool {
	root := filepath.Clean(backupStagingDir())
	d := filepath.Clean(p)
	if !strings.HasPrefix(d, root+string(filepath.Separator)) {
		return false
	}
	if st, err := os.Lstat(root); err != nil || !st.IsDir() {
		return false
	}
	cur := root
	for _, part := range strings.Split(strings.TrimPrefix(d, root+string(filepath.Separator)), string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		st, err := os.Lstat(cur)
		if err != nil {
			return errors.Is(err, os.ErrNotExist) // the rest is created by the worker
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return false
		}
	}
	return true
}

// stagingOwner is the backend user: the owner of the staging root. Files the
// worker leaves there are given to it, never to a uid a request names.
func stagingOwner() int {
	if st, err := os.Lstat(backupStagingDir()); err == nil {
		if o, ok := statOwner(st); ok {
			return o[0]
		}
	}
	return 0
}

// prepareStaging creates the staging root, readable by root and the backend
// user only. Its owner is set when it is created.
func prepareStaging(ownerUID int) error {
	root := backupStagingDir()
	if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(root, 0o700); err != nil {
			return err
		}
		if ownerUID > 0 {
			_ = os.Chown(root, ownerUID, -1)
		}
	}
	st, err := os.Lstat(root)
	if err != nil || !st.IsDir() {
		return errors.New("the backup staging directory is not a directory")
	}
	return os.Chmod(root, 0o700)
}

// readRegular reads a regular file, refusing symlinks and anything else.
func readRegular(p string) ([]byte, error) {
	st, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", p)
	}
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return readCapped(f, backupMaxTotal)
}

// backupFile is one entry of the archive: its archive path and its content
// source (a file on disk) or bytes.
type backupFile struct {
	path string
	src  string
	data []byte
}

// appFiles lists the files at the top of each app directory (compose.yaml,
// .env, configuration files). Subdirectories usually hold the app's data and
// are not configuration: they are left out, as are symlinks and large files.
func appFiles() []backupFile {
	var out []backupFile
	entries, _ := os.ReadDir(containersDir)
	for _, e := range entries {
		if !e.IsDir() || !reAppDir.MatchString(e.Name()) {
			continue
		}
		appDir := filepath.Join(containersDir, e.Name())
		if !fileExists(filepath.Join(appDir, "compose.yaml")) {
			continue
		}
		files, _ := os.ReadDir(appDir)
		for _, f := range files {
			if !f.Type().IsRegular() {
				continue
			}
			info, err := f.Info()
			if err != nil || info.Size() > backupMaxAppFile {
				continue
			}
			out = append(out, backupFile{path: "system/containers/" + e.Name() + "/" + f.Name(), src: filepath.Join(appDir, f.Name())})
		}
	}
	return out
}

func backupAccounts(usernames []string) accountsFile {
	acc := accountsFile{Users: []accountRec{}, Groups: []groupRec{}}
	for _, n := range usernames {
		if !reLinuxUsername.MatchString(n) {
			continue
		}
		if uid, gid, ok := hostLookupUser(n); ok {
			acc.Users = append(acc.Users, accountRec{Name: n, UID: uid, GID: gid})
		}
	}
	sort.Slice(acc.Users, func(i, j int) bool { return acc.Users[i].Name < acc.Users[j].Name })
	if gid, ok := hostLookupGroup("hsi-share"); ok {
		// Only the archived accounts: another member (an admin's own login)
		// may not exist where the backup is restored.
		archived := map[string]bool{}
		for _, u := range acc.Users {
			archived[u.Name] = true
		}
		var members []string
		for _, m := range hostGroupMembers("hsi-share") {
			if archived[m] {
				members = append(members, m)
			}
		}
		acc.Groups = append(acc.Groups, groupRec{Name: "hsi-share", GID: gid, Members: members})
	}
	return acc
}

// buildBackupTar writes dir/backup.tar from dir/database.db, dir/secrets.json
// (optional) and the system files.
func buildBackupTar(dir string, usernames []string, hsiVersion string, now time.Time) error {
	if !inStaging(dir) {
		return errors.New("the archive directory must be under the backup staging directory")
	}
	files := []backupFile{{path: "database.db", src: filepath.Join(dir, "database.db")}}
	if fileExists(filepath.Join(dir, "secrets.json")) {
		files = append(files, backupFile{path: "secrets.json", src: filepath.Join(dir, "secrets.json")})
	}
	acc, _ := json.MarshalIndent(backupAccounts(usernames), "", "  ")
	files = append(files, backupFile{path: "system/accounts.json", data: acc})
	files = append(files, appFiles()...)
	descs, _ := filepath.Glob(filepath.Join(storageDescriptionsDir(), "*.yaml"))
	sort.Strings(descs)
	for _, p := range descs {
		files = append(files, backupFile{path: "system/storage/" + filepath.Base(p), src: p})
	}
	if fileExists(maintenanceConfigPath) {
		files = append(files, backupFile{path: "system/maintenance.json", src: maintenanceConfigPath})
	}

	// Read every entry once: the manifest needs the sums before the files.
	contents := make([][]byte, len(files))
	var total int64
	host, _ := os.Hostname()
	m := backupManifest{Format: 2, HSIVersion: hsiVersion, CreatedAt: now.UTC().Format(time.RFC3339), Hostname: host}
	for i, f := range files {
		b := f.data
		if f.src != "" {
			var err error
			if b, err = readRegular(f.src); err != nil {
				return fmt.Errorf("read %s: %w", f.src, err)
			}
		}
		total += int64(len(b))
		if total > backupMaxTotal {
			return errors.New("the configuration is larger than 256 MiB")
		}
		contents[i] = b
		sum := sha256.Sum256(b)
		m.Items = append(m.Items, backupItem{Path: f.path, Size: int64(len(b)), SHA256: hex.EncodeToString(sum[:])})
	}
	manifest, _ := json.MarshalIndent(m, "", "  ")

	out := filepath.Join(dir, "backup.tar")
	_ = os.Remove(out)
	f, err := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(f)
	write := func(name string, b []byte) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(b)), ModTime: now, Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err := tw.Write(b)
		return err
	}
	err = write("manifest.json", manifest)
	for i := 0; err == nil && i < len(files); i++ {
		err = write(files[i].path, contents[i])
	}
	if cerr := tw.Close(); err == nil {
		err = cerr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(out)
	}
	return err
}

// chownTree gives dir (under the staging root) and its content to the
// backend user. WalkDir does not follow the symlinks it meets.
func chownTree(dir string, uid int) {
	if uid <= 0 || !inStaging(dir) {
		return
	}
	_ = filepath.WalkDir(dir, func(p string, _ os.DirEntry, err error) error {
		if err == nil {
			_ = os.Lchown(p, uid, -1)
		}
		return nil
	})
}

func handleConfigExport(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Dir        string   `json:"dir"`
		Usernames  []string `json:"usernames"`
		HSIVersion string   `json:"hsiVersion"`
		OwnerUID   int      `json:"ownerUid"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	if err := buildBackupTar(req.Dir, req.Usernames, req.HSIVersion, time.Now()); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	chownTree(req.Dir, stagingOwner())
	replyOk(nc, msg.Reply, map[string]any{"path": filepath.Join(req.Dir, "backup.tar")})
}

// handleConfigStaging creates the staging root for the backend user and
// replies its path, so the backend can stage files before an export or a
// restore.
func handleConfigStaging(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		OwnerUID int `json:"ownerUid"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	if err := prepareStaging(req.OwnerUID); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"dir": backupStagingDir()})
}

// readAll is io.ReadAll with a cap.
func readCapped(r io.Reader, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err == nil && int64(len(b)) > max {
		err = errors.New("entry too large")
	}
	return b, err
}
