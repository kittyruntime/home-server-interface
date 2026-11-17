package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/nats-io/nats.go"
)

// ── SFTP through the host's OpenSSH ──────────────────────────────────────────
// HSI never edits sshd_config: it owns one drop-in that confines the members
// of hsi-sftp to internal-sftp inside /var/lib/hsi-sftp/<user>. That folder
// holds one bind mount per share the user can read (read-only when they cannot
// write). Only accounts HSI created (no login shell) join the group, so
// nobody's SSH shell access ever changes.

const (
	sftpGroup  = "hsi-sftp"
	sftpRoot   = "/var/lib/hsi-sftp"
	sftpDropIn = `# Managed by HSI root-worker. Do not edit; regenerated on every sync.
# Members of hsi-sftp only get SFTP, inside their own folder of shares.
Match Group hsi-sftp
    ChrootDirectory /var/lib/hsi-sftp/%u
    ForceCommand internal-sftp -u 0002
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
    PasswordAuthentication yes
Match all
`
)

var (
	sshdConfigPath       = "/etc/ssh/sshd_config"
	sftpDropInPath       = "/etc/ssh/sshd_config.d/hsi-sftp.conf"
	reSshdIncludeDropIns = regexp.MustCompile(`(?mi)^[ \t]*include[ \t]+\S*sshd_config\.d/`)
)

// sshdReadsDropIns: the main configuration includes sshd_config.d.
func sshdReadsDropIns(conf string) bool {
	return reSshdIncludeDropIns.MatchString(conf)
}

// sftpAccounts splits users into those that may use SFTP (accounts without a
// login shell, as HSI creates them) and those left out (a real shell, no
// account, or root), both sorted.
func sftpAccounts(passwd string, users []string) (ok, left []string) {
	shells := map[string]string{}
	for _, l := range strings.Split(passwd, "\n") {
		f := strings.Split(l, ":")
		if len(f) == 7 {
			shells[f[0]] = f[6]
		}
	}
	for _, u := range users {
		if sh, found := shells[u]; found && u != "root" && reLinuxUsername.MatchString(u) && noLoginShells[sh] {
			ok = append(ok, u)
		} else {
			left = append(left, u)
		}
	}
	sort.Strings(ok)
	sort.Strings(left)
	return ok, left
}

// sftpViewPath is where a share appears for a user.
func sftpViewPath(user, share string) (string, error) {
	if user == "root" || !reLinuxUsername.MatchString(user) {
		return "", fmt.Errorf("invalid SFTP user %q", user)
	}
	if !reSmbShareName.MatchString(share) {
		return "", fmt.Errorf("invalid share name %q", share)
	}
	return filepath.Join(sftpRoot, user, share), nil
}

type mountEntry struct {
	MajMin     string
	Root       string
	MountPoint string
	ReadOnly   bool
}

func parseMountinfo(s string) []mountEntry {
	var out []mountEntry
	for _, l := range strings.Split(s, "\n") {
		f := strings.Fields(l)
		if len(f) < 6 {
			continue
		}
		opts := strings.Split(f[5], ",")
		out = append(out, mountEntry{MajMin: f[2], Root: unescapeMountinfo(f[3]), MountPoint: unescapeMountinfo(f[4]), ReadOnly: len(opts) > 0 && opts[0] == "ro"})
	}
	return out
}

func underSftpRoot(p string) bool { return strings.HasPrefix(p, sftpRoot+"/") }

// mountedAs is the device and the path inside it that src is, from the
// deepest mount holding it (never one of the SFTP views).
func mountedAs(entries []mountEntry, src string) (majmin, root string, ok bool) {
	best := ""
	for _, e := range entries {
		if underSftpRoot(e.MountPoint) {
			continue
		}
		within := e.MountPoint == src || e.MountPoint == "/" || strings.HasPrefix(src, e.MountPoint+"/")
		if within && len(e.MountPoint) >= len(best) {
			best, majmin = e.MountPoint, e.MajMin
			rel, _ := filepath.Rel(e.MountPoint, src)
			root, ok = path.Join(e.Root, rel), true
		}
	}
	return majmin, root, ok
}

type sftpMount struct {
	Dst string
	Src string
	RO  bool
}

// sftpMountPlan compares the views wanted with the ones mounted: what to
// unmount (gone, or pointing elsewhere; topmost first), to mount, and to
// switch between read-only and read-write.
func sftpMountPlan(desired []sftpMount, entries []mountEntry) (unmount []string, mount, remount []sftpMount) {
	want := map[string]sftpMount{}
	for _, d := range desired {
		want[d.Dst] = d
	}
	kept := map[string]bool{}
	seen := map[string]bool{}
	for i := len(entries) - 1; i >= 0; i-- {
		b := entries[i]
		if !underSftpRoot(b.MountPoint) {
			continue
		}
		d, ok := want[b.MountPoint]
		if seen[b.MountPoint] || !ok {
			unmount = append(unmount, b.MountPoint)
			seen[b.MountPoint] = true
			continue
		}
		seen[b.MountPoint] = true
		majmin, root, found := mountedAs(entries, d.Src)
		if !found || majmin != b.MajMin || root != b.Root {
			unmount = append(unmount, b.MountPoint)
			continue
		}
		kept[d.Dst] = true
		if b.ReadOnly != d.RO {
			remount = append(remount, d)
		}
	}
	for _, d := range desired {
		if !kept[d.Dst] {
			mount = append(mount, d)
		}
	}
	return unmount, mount, remount
}

// sftpBindsOn are the SFTP views showing a folder of the filesystem mounted
// at mp, topmost first: they keep it busy, so they go before it is unmounted.
func sftpBindsOn(entries []mountEntry, mp string) []string {
	var target *mountEntry
	for i := range entries {
		if entries[i].MountPoint == mp {
			target = &entries[i]
		}
	}
	if target == nil {
		return nil
	}
	var out []string
	for i := len(entries) - 1; i >= 0; i-- {
		b := entries[i]
		if underSftpRoot(b.MountPoint) && b.MajMin == target.MajMin &&
			(target.Root == "/" || b.Root == target.Root || strings.HasPrefix(b.Root, target.Root+"/")) {
			out = append(out, b.MountPoint)
		}
	}
	return out
}

// ── Plan ─────────────────────────────────────────────────────────────────────

type sftpShareDef struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Write       bool   `json:"write"`
	Unavailable bool   `json:"unavailable"`
}

type sftpUserDef struct {
	User   string         `json:"user"`
	Shares []sftpShareDef `json:"shares"`
}

var (
	// hostSshdCheck validates sshd's whole configuration, drop-ins included.
	hostSshdCheck = func() ([]byte, error) { return probe("sshd", "-t").CombinedOutput() }
	// hostPrepareSftpDirs makes each folder (parents first) root's and 0755,
	// as sshd requires of every folder on the way to a chroot.
	hostPrepareSftpDirs = prepareSftpDirs
	// hostTidySftp removes folders left empty, never anything inside them.
	hostTidySftp = tidySftpDirs
	// hostSafeFolder refuses a share folder that someone other than root could
	// swap for a link to elsewhere.
	hostSafeFolder = func(p string) error { return safeShareFolder(p, ownedByRoot) }
	// hostUmountView takes down a view that could not be made read-only.
	hostUmountView = func(dst string) { _ = probe("umount", "-l", dst).Run() }
)

func ownedByRoot(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0
}

// safeShareFolder: p is a real folder (not a link) and every folder above it
// is root's and writable by nobody else, sticky or not (under a sticky
// folder like /tmp, p's owner could still rename it). Then only root can swap
// p for something else, so what was checked is what gets mounted or
// exported: no window between the check and its use.
func safeShareFolder(p string, rootOwned func(os.FileInfo) bool) error {
	return safeShareFolderUpTo(p, rootOwned, "/")
}

// safeShareFolderUpTo checks the folders above p up to top included.
func safeShareFolderUpTo(p string, rootOwned func(os.FileInfo) bool, top string) error {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return fmt.Errorf("%q is not an absolute path", p)
	}
	fi, err := os.Lstat(p)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a folder (a symbolic link?)", p)
	}
	for dir := filepath.Dir(p); ; dir = filepath.Dir(dir) {
		fi, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			return fmt.Errorf("%s is a symbolic link", dir)
		}
		if !rootOwned(fi) {
			return fmt.Errorf("%s does not belong to root", dir)
		}
		if fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("others can write in %s, so they could swap the share's folder", dir)
		}
		if dir == top || dir == "/" {
			return nil
		}
	}
}

// mountViewStep shows src in dst, read-only from the first instant when ro
// (one mount call), after checking src is still the real folder: a writer of
// a parent folder must not swap it for a link to elsewhere.
func mountViewStep(m sftpMount) planStep {
	argv := []string{"mount", "--bind", m.Src, m.Dst}
	summary := "Show " + m.Src + " in " + m.Dst
	if m.RO {
		argv = []string{"mount", "--bind", "-o", "ro", m.Src, m.Dst}
		summary += ", read-only"
	}
	return planStep{Kind: "run", Target: m.Dst, Summary: summary, Command: argv, run: func() (string, error) {
		if err := hostSafeFolder(m.Src); err != nil {
			return "", fmt.Errorf("%s is not shown over SFTP: %v", m.Src, err)
		}
		out, err := runArgv(argv)
		if err != nil {
			if m.RO {
				hostUmountView(m.Dst)
			}
			return "", cmdError{cmdErrMessage(out, err)}
		}
		return "", nil
	}}
}

func prepareSftpDirs(dirs []string) error {
	for _, d := range append([]string{sftpRoot}, dirs...) {
		if !strings.HasPrefix(d+"/", sftpRoot+"/") {
			return fmt.Errorf("refusing %s outside %s", d, sftpRoot)
		}
		if err := os.Mkdir(d, 0o755); err != nil && !os.IsExist(err) {
			return err
		}
		fi, err := os.Lstat(d)
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			return fmt.Errorf("%s is not a folder", d)
		}
		if err := os.Chown(d, 0, 0); err != nil {
			return err
		}
		if err := os.Chmod(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func tidySftpDirs(dirs []string) error {
	for _, d := range dirs {
		if underSftpRoot(d) {
			// Not recursive: a folder that is still a mount or not empty stays.
			_ = os.Remove(d)
		}
	}
	return nil
}

func sshdInstalled() bool { return hostLookPath("sshd") || hostExists("/usr/sbin/sshd") }

// sshdUnit is the service name of the SSH server: ssh on Debian and Ubuntu,
// sshd elsewhere.
func sshdUnit() string {
	for _, dir := range []string{"/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"} {
		if hostExists(dir + "/ssh.service") {
			return "ssh"
		}
	}
	return "sshd"
}

// groupMembers reads a group's members from /etc/group; ok is false when the
// group does not exist.
func groupMembers(groupFile, name string) (members []string, ok bool) {
	for _, l := range strings.Split(groupFile, "\n") {
		f := strings.Split(l, ":")
		if len(f) == 4 && f[0] == name {
			for _, m := range strings.Split(f[3], ",") {
				if m != "" {
					members = append(members, m)
				}
			}
			sort.Strings(members)
			return members, true
		}
	}
	return nil, false
}

func userOfView(dst string) string {
	rel := strings.TrimPrefix(dst, sftpRoot+"/")
	user, _, _ := strings.Cut(rel, "/")
	return user
}

// sftpSyncSteps confines the accounts that can use SFTP to their shares.
func sftpSyncSteps(users []sftpUserDef, obs map[string]string) ([]planStep, *fsError) {
	var names []string
	for _, u := range users {
		names = append(names, u.User)
	}
	passwd, _ := hostReadFile("/etc/passwd")
	ok, _ := sftpAccounts(string(passwd), names)
	allowed := map[string]bool{}
	for _, u := range ok {
		allowed[u] = true
	}

	var desired []sftpMount
	var dirs []string
	for _, u := range users {
		if !allowed[u.User] {
			continue
		}
		base := filepath.Join(sftpRoot, u.User)
		dirs = append(dirs, base)
		for _, s := range u.Shares {
			dst, err := sftpViewPath(u.User, s.Name)
			if err != nil {
				return nil, &fsError{Code: "ERR", Message: err.Error()}
			}
			if !validNfsPath(s.Path) {
				return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("invalid share path %q", s.Path)}
			}
			if s.Unavailable {
				continue
			}
			if err := hostSafeFolder(s.Path); err != nil {
				// Left out like a missing volume, so one share never stops the rest.
				log.Printf("sftp: %s not shown: %v", s.Path, err)
				continue
			}
			dirs = append(dirs, dst)
			desired = append(desired, sftpMount{Dst: dst, Src: s.Path, RO: !s.Write})
		}
	}
	if len(ok) > 0 {
		if !sshdInstalled() {
			return nil, &fsError{Code: "SFTP_MISSING", Message: "OpenSSH's server is not installed"}
		}
		conf, _ := hostReadFile(sshdConfigPath)
		if !sshdReadsDropIns(string(conf)) {
			return nil, &fsError{Code: "SFTP_UNSUPPORTED", Message: sshdConfigPath + " does not include sshd_config.d"}
		}
	}

	mi, _ := hostReadFile("/proc/self/mountinfo")
	entries := parseMountinfo(string(mi))
	unmount, mount, remount := sftpMountPlan(desired, entries)
	groups, _ := hostReadFile("/etc/group")
	members, groupExists := groupMembers(string(groups), sftpGroup)
	cur, dropErr := hostReadFile(sftpDropInPath)
	current, dropExists := string(cur), dropErr == nil
	obs["sftp.dropIn"] = current
	obs["sftp.group"] = strings.Join(members, ",")
	var views []string
	for _, e := range entries {
		if underSftpRoot(e.MountPoint) {
			views = append(views, e.MajMin+" "+e.Root+" "+e.MountPoint+" "+strconv.FormatBool(e.ReadOnly))
		}
	}
	obs["sftp.views"] = strings.Join(views, "\n")

	var steps []planStep
	if len(ok) > 0 && !groupExists {
		steps = append(steps, cmdStep(sftpGroup, "Create the group of the accounts that may use SFTP", []string{"groupadd", "-f", sftpGroup}))
	}
	if (groupExists || len(ok) > 0) && !reflect.DeepEqual(members, ok) && !(len(members) == 0 && len(ok) == 0) {
		steps = append(steps, cmdStep(sftpGroup, "Set who may use SFTP: "+orNobody(ok),
			[]string{"gpasswd", "-M", strings.Join(ok, ","), sftpGroup}))
	}

	// Access taken away: the view goes, and so do the sessions that had it.
	revoked := map[string]bool{}
	var tidy []string
	wanted := map[string]bool{}
	for _, d := range desired {
		wanted[d.Dst] = true
	}
	for _, dst := range unmount {
		steps = append(steps, cmdStep(dst, "Close the SFTP view "+dst, []string{"umount", "-l", dst}))
		u := userOfView(dst)
		if !wanted[dst] {
			revoked[u] = true
			tidy = append(tidy, dst)
		}
	}
	var gone []string
	for u := range revoked {
		gone = append(gone, u)
	}
	sort.Strings(gone)
	for _, u := range gone {
		kill := cmdStep(u, "End "+u+"'s SFTP sessions so they lose what was taken away", []string{"pkill", "-u", u, "-f", "@internal-sftp"})
		kill.OnFailure = "warn" // nobody connected
		steps = append(steps, kill)
		if !allowed[u] {
			tidy = append(tidy, filepath.Join(sftpRoot, u))
		}
	}
	if len(tidy) > 0 {
		steps = append(steps, planStep{Kind: "delete", Target: sftpRoot, Summary: "Remove the empty SFTP folders",
			run: func() (string, error) { return "", hostTidySftp(tidy) }})
	}

	if len(mount) > 0 || len(remount) > 0 {
		steps = append(steps, planStep{Kind: "create", Target: sftpRoot, Summary: "Prepare the SFTP folders (root's, as sshd requires)",
			run: func() (string, error) { return "", hostPrepareSftpDirs(dirs) }})
	}
	for _, m := range mount {
		steps = append(steps, mountViewStep(m))
	}
	for _, m := range remount {
		mode, what := "rw", "writable"
		if m.RO {
			mode, what = "ro", "read-only"
		}
		steps = append(steps, cmdStep(m.Dst, "Make "+m.Dst+" "+what, []string{"mount", "-o", "remount,bind," + mode, m.Dst}))
		if m.RO {
			// Files opened for writing before stay writable: end those sessions.
			u := userOfView(m.Dst)
			kill := cmdStep(u, "End "+u+"'s SFTP sessions so open files lose write access", []string{"pkill", "-u", u, "-f", "@internal-sftp"})
			kill.OnFailure = "warn"
			steps = append(steps, kill)
		}
	}

	reload := false
	switch {
	case len(ok) > 0 && current != sftpDropIn:
		kind := "update"
		if !dropExists {
			kind = "create"
		}
		steps = append(steps, planStep{Kind: kind, Target: sftpDropInPath,
			Summary: "Confine the SFTP accounts to their shares (checked with sshd -t before it is used)",
			Diff:    unifiedDiff(sftpDropInPath, current, sftpDropIn),
			run:     func() (string, error) { return "", installSftpDropIn(current, dropExists) }})
		reload = true
	case len(ok) == 0 && dropExists:
		steps = append(steps, planStep{Kind: "delete", Target: sftpDropInPath, Summary: "Stop serving SFTP",
			Diff: unifiedDiff(sftpDropInPath, current, ""),
			run:  func() (string, error) { return "", hostRemoveFile(sftpDropInPath) }})
		reload = true
	}
	if reload {
		r := cmdStep("sshd", "Have the SSH server read its configuration again (open sessions stay)",
			[]string{"systemctl", "try-reload-or-restart", sshdUnit()})
		r.OnFailure = "warn"
		steps = append(steps, r)
	}
	return steps, nil
}

func orNobody(users []string) string {
	if len(users) == 0 {
		return "nobody"
	}
	return strings.Join(users, ", ")
}

// installSftpDropIn writes the drop-in, then has sshd check its whole
// configuration; a refusal puts the previous file back, so the SSH server is
// never reloaded with a configuration it rejects.
func installSftpDropIn(previous string, existed bool) error {
	if err := hostWriteFile(sftpDropInPath, sftpDropIn); err != nil {
		return err
	}
	out, err := hostSshdCheck()
	if err == nil {
		return nil
	}
	if existed {
		_ = hostWriteFile(sftpDropInPath, previous)
	} else {
		_ = hostRemoveFile(sftpDropInPath)
	}
	return fmt.Errorf("sshd refused the configuration, nothing changed: %s", strings.TrimSpace(string(out)))
}

// closeSftpViewsSteps unmount the SFTP views of the filesystem mounted at mp,
// which would otherwise keep it in use after it is unmounted. The next share
// sync puts them back once the volume is there again.
func closeSftpViewsSteps(mp string) []planStep {
	mi, _ := hostReadFile("/proc/self/mountinfo")
	var steps []planStep
	for _, dst := range sftpBindsOn(parseMountinfo(string(mi)), mp) {
		steps = append(steps, cmdStep(dst, "Close the SFTP view "+dst+" of "+mp, []string{"umount", "-l", dst}))
	}
	return steps
}

// sshdPort is the first port of `sshd -T` output, 22 when none is listed.
func sshdPort(effective string) int {
	for _, l := range strings.Split(effective, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "port "); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 && n < 65536 {
				return n
			}
		}
	}
	return 22
}

// sftpSessions are the accounts with an SFTP session open, from `ps -eo user=,args=`.
func sftpSessions(ps string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, l := range strings.Split(ps, "\n") {
		f := strings.Fields(l)
		if len(f) < 2 || !strings.HasSuffix(f[len(f)-1], "@internal-sftp") || seen[f[0]] {
			continue
		}
		seen[f[0]] = true
		out = append(out, f[0])
	}
	sort.Strings(out)
	return out
}

func handleSharingSftp(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Users []string `json:"users"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	installed := sshdInstalled()
	conf, _ := hostReadFile(sshdConfigPath)
	passwd, _ := hostReadFile("/etc/passwd")
	_, left := sftpAccounts(string(passwd), req.Users)
	res := map[string]any{"installed": installed, "supported": installed && sshdReadsDropIns(string(conf)),
		"active": false, "port": 22, "sessions": []string{}, "leftOut": left}
	if installed {
		unit := sshdUnit()
		res["active"] = smbRun("systemctl", "is-active", "--quiet", unit) == nil || smbRun("systemctl", "is-active", "--quiet", unit+".socket") == nil
		if o, err := probe("sshd", "-T").Output(); err == nil {
			res["port"] = sshdPort(string(o))
		}
		if o, err := probe("ps", "-eo", "user:32=,args=").Output(); err == nil {
			res["sessions"] = sftpSessions(string(o))
		}
	}
	replyOk(nc, msg.Reply, res)
}
