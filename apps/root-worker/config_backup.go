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
	backupMaxDepth   = 4 // directories under an app directory
	backupMaxTotal   = 256 << 20
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

// inStaging tells whether dir is a subdirectory of the staging root.
func inStaging(dir string) bool {
	root := filepath.Clean(backupStagingDir())
	d := filepath.Clean(dir)
	return strings.HasPrefix(d, root+string(filepath.Separator))
}

// prepareStaging creates the staging root, readable by root and the backend
// user only.
func prepareStaging(ownerUID int) error {
	root := backupStagingDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	if ownerUID > 0 {
		_ = os.Chown(root, ownerUID, -1)
	}
	return os.Chmod(root, 0o700)
}

// backupFile is one entry of the archive: its archive path and its content
// source (a file on disk) or bytes.
type backupFile struct {
	path string
	src  string
	data []byte
}

// appFiles lists the regular files of each app directory: no symlinks, no
// large files (data, not configuration), not too deep.
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
		_ = filepath.WalkDir(appDir, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(appDir, p)
			depth := strings.Count(rel, string(filepath.Separator))
			if d.IsDir() {
				if rel != "." && depth >= backupMaxDepth {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 || !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Size() > backupMaxAppFile {
				return nil
			}
			out = append(out, backupFile{path: "system/containers/" + e.Name() + "/" + filepath.ToSlash(rel), src: p})
			return nil
		})
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
		acc.Groups = append(acc.Groups, groupRec{Name: "hsi-share", GID: gid, Members: hostGroupMembers("hsi-share")})
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
			if b, err = os.ReadFile(f.src); err != nil {
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
	f, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
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

// chownTree gives dir and its content to the backend user.
func chownTree(dir string, uid int) {
	if uid <= 0 {
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
	chownTree(req.Dir, req.OwnerUID)
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
