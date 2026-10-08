package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
	"gopkg.in/yaml.v3"
)

// ── Configuration restore v2 (#1) ────────────────────────────────────────────
// Unpack an archive the backend decrypted, report what restoring it would
// change and what conflicts, then apply its system part: accounts with their
// original ids, app definitions (stopped), storage descriptions and the
// maintenance schedule. Disks, volumes and app data are never touched; what an
// archive replaces is kept aside.

var (
	hostUserByUID = func(uid int) (string, bool) {
		u, err := user.LookupId(strconv.Itoa(uid))
		if err != nil {
			return "", false
		}
		return u.Username, true
	}
	hostGroupByGID = func(gid int) (string, bool) {
		g, err := user.LookupGroupId(strconv.Itoa(gid))
		if err != nil {
			return "", false
		}
		return g.Name, true
	}
)

// unpackBackupTar extracts an archive into dest (under the staging root) and
// checks it against its manifest: regular files only, no path leaving dest,
// every file listed with its size and sum, nothing missing or extra.
func unpackBackupTar(tarPath, dest string) (backupManifest, error) {
	var m backupManifest
	if !inStaging(dest) {
		return m, errors.New("the restore directory must be under the backup staging directory")
	}
	f, err := os.Open(tarPath)
	if err != nil {
		return m, err
	}
	defer f.Close()
	sums := map[string]backupItem{}
	var total int64
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return m, fmt.Errorf("the archive is damaged: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			return m, fmt.Errorf("the archive holds something other than files: %s", h.Name)
		}
		name := filepath.Clean(filepath.FromSlash(h.Name))
		if filepath.IsAbs(h.Name) || !filepath.IsLocal(name) {
			return m, fmt.Errorf("the archive holds a path outside it: %s", h.Name)
		}
		total += h.Size
		if total > backupMaxTotal {
			return m, errors.New("the archive is larger than 256 MiB")
		}
		b, err := readCapped(tr, backupMaxTotal)
		if err != nil {
			return m, err
		}
		if name == "manifest.json" {
			if err := json.Unmarshal(b, &m); err != nil {
				return m, fmt.Errorf("unreadable manifest: %w", err)
			}
			continue
		}
		target := filepath.Join(dest, name)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return m, err
		}
		if err := os.WriteFile(target, b, 0o600); err != nil {
			return m, err
		}
		sum := sha256.Sum256(b)
		sums[filepath.ToSlash(name)] = backupItem{Path: filepath.ToSlash(name), Size: int64(len(b)), SHA256: hex.EncodeToString(sum[:])}
	}
	if m.Format != 2 {
		return m, errors.New("not a configuration archive of format 2")
	}
	listed := map[string]bool{}
	for _, it := range m.Items {
		got, ok := sums[it.Path]
		if !ok {
			return m, fmt.Errorf("the archive lacks %s", it.Path)
		}
		if got.Size != it.Size || got.SHA256 != it.SHA256 {
			return m, fmt.Errorf("%s does not match the manifest", it.Path)
		}
		listed[it.Path] = true
	}
	for p := range sums {
		if !listed[p] {
			return m, fmt.Errorf("%s is not in the manifest", p)
		}
	}
	return m, nil
}

type configConflict struct {
	Kind    string `json:"kind"` // uid-taken | gid-taken | name-other-id
	Name    string `json:"name"`
	Detail  string `json:"detail"`
	Command string `json:"command"`
}

type configApp struct {
	Name  string `json:"name"`
	State string `json:"state"` // new | same | different
}

type configVolume struct {
	MountPoint   string `json:"mountPoint"`
	DisksPresent int    `json:"disksPresent"`
	DisksMissing int    `json:"disksMissing"`
}

type configCheck struct {
	Conflicts []configConflict `json:"conflicts"`
	Apps      []configApp      `json:"apps"`
	Volumes   []configVolume   `json:"volumes"`
}

func readAccounts(dir string) (accountsFile, error) {
	var acc accountsFile
	b, err := os.ReadFile(filepath.Join(dir, "system", "accounts.json"))
	if err != nil {
		return acc, err
	}
	return acc, json.Unmarshal(b, &acc)
}

// accountConflicts compares the archive's accounts with the server's: an id
// held by another name, or a name holding another id.
func accountConflicts(acc accountsFile) []configConflict {
	var out []configConflict
	add := func(kind, name, detail, cmd string) {
		out = append(out, configConflict{Kind: kind, Name: name, Detail: detail, Command: cmd})
	}
	groups := map[string]int{}
	for _, g := range acc.Groups {
		groups[g.Name] = g.GID
	}
	for _, u := range acc.Users {
		if _, ok := groups[u.Name]; !ok {
			groups[u.Name] = u.GID // the user's own group
		}
		if uid, gid, ok := hostLookupUser(u.Name); ok {
			if uid != u.UID || gid != u.GID {
				add("name-other-id", u.Name, fmt.Sprintf("the account %s exists here with uid %d and gid %d, the backup has %d and %d", u.Name, uid, gid, u.UID, u.GID),
					fmt.Sprintf("sudo usermod -u %d -g %d %s", u.UID, u.GID, u.Name))
			}
			continue
		}
		if other, ok := hostUserByUID(u.UID); ok {
			add("uid-taken", u.Name, fmt.Sprintf("uid %d of %s belongs to %s here", u.UID, u.Name, other),
				fmt.Sprintf("sudo usermod -u <another uid> %s   # or remove %s", other, other))
		}
	}
	names := make([]string, 0, len(groups))
	for n := range groups {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		gid := groups[n]
		if have, ok := hostLookupGroup(n); ok {
			if have != gid {
				add("name-other-id", n, fmt.Sprintf("the group %s exists here with gid %d, the backup has %d", n, have, gid),
					fmt.Sprintf("sudo groupmod -g %d %s", gid, n))
			}
			continue
		}
		if other, ok := hostGroupByGID(gid); ok {
			add("gid-taken", n, fmt.Sprintf("gid %d of %s belongs to the group %s here", gid, n, other),
				fmt.Sprintf("sudo groupmod -g <another gid> %s   # or remove %s", other, other))
		}
	}
	return out
}

// backupApps lists the app directories of an unpacked archive.
func backupApps(dir string) []string {
	entries, _ := os.ReadDir(filepath.Join(dir, "system", "containers"))
	var out []string
	for _, e := range entries {
		if e.IsDir() && reAppDir.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// sameTree tells whether two directories hold the same regular files.
func sameTree(a, b string) bool {
	list := func(root string) map[string][]byte {
		out := map[string][]byte{}
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() {
				rel, _ := filepath.Rel(root, p)
				out[rel], _ = os.ReadFile(p)
			}
			return nil
		})
		return out
	}
	x, y := list(a), list(b)
	if len(x) != len(y) {
		return false
	}
	for k, v := range x {
		if w, ok := y[k]; !ok || !bytes.Equal(v, w) {
			return false
		}
	}
	return true
}

func checkBackup(dir string) configCheck {
	c := configCheck{Conflicts: []configConflict{}, Apps: []configApp{}, Volumes: []configVolume{}}
	if acc, err := readAccounts(dir); err == nil {
		c.Conflicts = append(c.Conflicts, accountConflicts(acc)...)
	}
	for _, app := range backupApps(dir) {
		state := "new"
		if cur := filepath.Join(containersDir, app); fileExists(cur) {
			state = "different"
			if sameTree(cur, filepath.Join(dir, "system", "containers", app)) {
				state = "same"
			}
		}
		c.Apps = append(c.Apps, configApp{Name: app, State: state})
	}
	descs, _ := filepath.Glob(filepath.Join(dir, "system", "storage", "*.yaml"))
	sort.Strings(descs)
	present := hostDiskKeys()
	for _, p := range descs {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var d storageDescription
		if yaml.Unmarshal(raw, &d) != nil || d.Mount.Point == "" {
			continue
		}
		v := configVolume{MountPoint: d.Mount.Point}
		for _, k := range d.Disks {
			key := diskKey(k)
			if (key == k.ByID && hostExists(k.ByID)) || present[key] {
				v.DisksPresent++
			} else {
				v.DisksMissing++
			}
		}
		c.Volumes = append(c.Volumes, v)
	}
	return c
}

// validAccounts refuses system ids and names that are not Linux usernames.
func validAccounts(acc accountsFile) error {
	for _, u := range acc.Users {
		if !reLinuxUsername.MatchString(u.Name) || u.UID < 1000 || u.UID >= 60000 || u.GID < 1000 || u.GID >= 60000 {
			return fmt.Errorf("the backup holds an account HSI does not restore: %q (uid %d, gid %d)", u.Name, u.UID, u.GID)
		}
	}
	for _, g := range acc.Groups {
		if g.Name != "hsi-share" || g.GID < 100 || g.GID >= 60000 {
			return fmt.Errorf("the backup holds a group HSI does not restore: %q (gid %d)", g.Name, g.GID)
		}
		for _, m := range g.Members {
			if !reLinuxUsername.MatchString(m) {
				return fmt.Errorf("invalid member %q of %s", m, g.Name)
			}
		}
	}
	return nil
}

func runChecked(argv ...string) error {
	if out, err := runArgv(argv); err != nil {
		return fmt.Errorf("%s: %s", strings.Join(argv, " "), cmdErrMessage(out, err))
	}
	return nil
}

// copyTree copies the regular files of src into dst.
func copyTree(src, dst string, uid, gid int) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			_ = os.Chown(target, uid, gid)
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if strings.HasPrefix(filepath.Base(p), ".env") {
			mode = 0o600
		}
		if err := os.WriteFile(target, b, mode); err != nil {
			return err
		}
		_ = os.Chown(target, uid, gid)
		return nil
	})
}

// keepAside renames path to path+suffix when it exists.
func keepAside(path, suffix string) error {
	if !fileExists(path) {
		return nil
	}
	return os.Rename(path, path+suffix)
}

// applyBackup restores the system part of an unpacked archive. The conflicts
// are checked again first: an account created since the preview blocks too.
func applyBackup(dir string, now time.Time) error {
	if !inStaging(dir) {
		return errors.New("the restore directory must be under the backup staging directory")
	}
	acc, err := readAccounts(dir)
	if err != nil {
		return fmt.Errorf("read the accounts: %w", err)
	}
	if err := validAccounts(acc); err != nil {
		return err
	}
	if c := accountConflicts(acc); len(c) > 0 {
		return fmt.Errorf("%d account conflict(s) appeared since the preview: check the backup again", len(c))
	}

	// Groups first (hsi-share and each user's own group), then users.
	ensureGroup := func(name string, gid int) error {
		if _, ok := hostLookupGroup(name); ok {
			return nil
		}
		return runChecked("groupadd", "-g", strconv.Itoa(gid), name)
	}
	for _, g := range acc.Groups {
		if err := ensureGroup(g.Name, g.GID); err != nil {
			return err
		}
	}
	for _, u := range acc.Users {
		if _, _, ok := hostLookupUser(u.Name); ok {
			continue
		}
		if err := ensureGroup(u.Name, u.GID); err != nil {
			return err
		}
		if err := runChecked("useradd", "-u", strconv.Itoa(u.UID), "-g", strconv.Itoa(u.GID), "-M", "-s", "/usr/sbin/nologin", u.Name); err != nil {
			return err
		}
	}
	for _, g := range acc.Groups {
		for _, m := range g.Members {
			if err := runChecked("usermod", "-aG", g.Name, m); err != nil {
				return err
			}
		}
	}

	stamp := now.UTC().Format("20060102-150405")
	owner := func(p string) (int, int) {
		if st, err := os.Stat(p); err == nil {
			if s, ok := statOwner(st); ok {
				return s[0], s[1]
			}
		}
		return 0, 0
	}
	_ = os.MkdirAll(containersDir, 0o755)
	uid, gid := owner(containersDir)
	for _, app := range backupApps(dir) {
		src := filepath.Join(dir, "system", "containers", app)
		dst := filepath.Join(containersDir, app)
		if fileExists(dst) {
			if sameTree(dst, src) {
				continue
			}
			if err := keepAside(dst, ".before-restore-"+stamp); err != nil {
				return err
			}
		}
		if err := copyTree(src, dst, uid, gid); err != nil {
			return fmt.Errorf("restore the app %s: %w", app, err)
		}
	}

	descs, _ := filepath.Glob(filepath.Join(dir, "system", "storage", "*.yaml"))
	if len(descs) > 0 {
		if err := os.MkdirAll(storageDescriptionsDir(), 0o755); err != nil {
			return err
		}
	}
	for _, p := range descs {
		dst := filepath.Join(storageDescriptionsDir(), filepath.Base(p))
		b, _ := os.ReadFile(p)
		if cur, err := os.ReadFile(dst); err == nil {
			if bytes.Equal(cur, b) {
				continue
			}
			if err := keepAside(dst, ".before-restore"); err != nil {
				return err
			}
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return err
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "system", "maintenance.json")); err == nil {
		if cur, err := os.ReadFile(maintenanceConfigPath); err != nil || !bytes.Equal(cur, b) {
			_ = keepAside(maintenanceConfigPath, ".before-restore")
			if err := os.WriteFile(maintenanceConfigPath, b, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

// replaceSecretsKey sets HSI_SECRETS_KEY in the backend .env, keeping the
// previous file as .env.before-restore.
func replaceSecretsKey(envPath, key string) error {
	if key == "" || strings.ContainsAny(key, "\r\n= ") {
		return errors.New("invalid secrets key")
	}
	cur, err := os.ReadFile(envPath)
	if err != nil {
		return err
	}
	if err := os.WriteFile(envPath+".before-restore", cur, 0o600); err != nil {
		return err
	}
	lines := splitConf(string(cur))
	found := false
	for i, l := range lines {
		if strings.HasPrefix(l, "HSI_SECRETS_KEY=") {
			lines[i] = "HSI_SECRETS_KEY=" + key
			found = true
		}
	}
	if !found {
		lines = append(lines, "HSI_SECRETS_KEY="+key)
	}
	return writeFileAtomic(envPath, []byte(joinConf(lines)), 0o600)
}

func handleConfigUnpack(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Tar      string `json:"tar"`
		Dest     string `json:"dest"`
		OwnerUID int    `json:"ownerUid"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	if !inStaging(req.Tar) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "the archive must be under the backup staging directory"})
		return
	}
	m, err := unpackBackupTar(req.Tar, req.Dest)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "EBADBACKUP", Message: err.Error()})
		return
	}
	chownTree(req.Dest, req.OwnerUID)
	replyOk(nc, msg.Reply, m)
}

func handleConfigCheck(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Dir string `json:"dir"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	if !inStaging(req.Dir) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "the restore directory must be under the backup staging directory"})
		return
	}
	replyOk(nc, msg.Reply, checkBackup(req.Dir))
}

func handleConfigApply(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Dir string `json:"dir"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	if err := applyBackup(req.Dir, time.Now()); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{})
}

func handleConfigSecretsKey(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Key     string `json:"key"`
		EnvPath string `json:"envPath"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	if filepath.Base(req.EnvPath) != ".env" || !filepath.IsAbs(req.EnvPath) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid .env path"})
		return
	}
	if err := replaceSecretsKey(req.EnvPath, req.Key); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{})
}

// statOwner returns the uid and gid of a file.
func statOwner(st os.FileInfo) ([2]int, bool) {
	s, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return [2]int{}, false
	}
	return [2]int{int(s.Uid), int(s.Gid)}, true
}
