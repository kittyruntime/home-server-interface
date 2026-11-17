package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"

	nats "github.com/nats-io/nats.go"
	"golang.org/x/sys/unix"
)

// SMB sharing handlers. The app owns /etc/nasui/samba/smb.conf and points
// smbd at it through a systemd drop-in; the samba package's own
// /etc/samba/smb.conf is never modified, so apt upgrades stay conflict-free
// (no dpkg-divert, no conffile prompt).
const (
	smbConfDir  = "/etc/nasui/samba"
	smbConfPath = smbConfDir + "/smb.conf"
	dropInDir   = "/etc/systemd/system/smbd.service.d"
	dropInPath  = dropInDir + "/nasui.conf"

	// Shared group owning writable share directories. Write-permitted users are
	// its members; share dirs are chgrp'd to it and made setgid + group-writable
	// so both SMB and the web file-manager (both write as the connecting user)
	// can write. Samba's valid-users/write-list still gates who may connect.
	shareGroup = "hsi-share"
)

const dropInContent = `# Managed by nasui: points smbd at the app-owned config instead of the
# samba package's /etc/samba/smb.conf (systemd drop-in, no dpkg-divert).
[Service]
ExecStart=
ExecStart=/usr/sbin/smbd --foreground --no-process-group --configfile=` + smbConfPath + `
`

var reSmbShareName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)

type shareDef struct {
	Name       string   `json:"name"`
	Path       string   `json:"path"`
	ReadOnly   bool     `json:"readOnly"`
	GuestOk    bool     `json:"guestOk"`
	ValidUsers []string `json:"validUsers"`
	WriteUsers []string `json:"writeUsers"`
	// Unavailable: the share's volume is missing (#3); clients see the share
	// as unavailable instead of an empty folder on the boot disk.
	Unavailable bool `json:"unavailable"`
	// Hidden: left out of network browsing (browseable = no); still reachable
	// by its address.
	Hidden bool `json:"hidden"`
	// TimeMachine: a Mac can back up to this share (vfs_fruit); a cap in GB
	// when TimeMachineMaxGb > 0.
	TimeMachine      bool `json:"timeMachine"`
	TimeMachineMaxGb int  `json:"timeMachineMaxGb"`
}

// smbLogPath receives smbd's log, including the authentication and share
// audit lines root.sharing.events reads.
const smbLogPath = "/var/log/hsi/samba/smbd.log"

// smbSettings is the service-wide part of smb.conf. Empty values keep the
// historical defaults, so a sync without settings renders today's file.
type smbSettings struct {
	NetbiosName string   `json:"netbiosName"`
	Workgroup   string   `json:"workgroup"`
	MinProtocol string   `json:"minProtocol"` // "SMB2" | "SMB3"
	Encryption  string   `json:"encryption"`  // "off" | "desired" | "required"
	HostsDeny   []string `json:"hostsDeny"`
	// Audit: this Samba can log JSON authentication events and has
	// vfs_full_audit; without both, the audit lines would stop smbd.
	Audit bool `json:"audit"`
}

var reNetbiosName = regexp.MustCompile(`^[A-Za-z0-9-]{1,15}$`)

// globalLines validates s and returns its [global] lines.
func (s smbSettings) globalLines() ([]string, error) {
	var lines []string
	if s.NetbiosName != "" {
		if !reNetbiosName.MatchString(s.NetbiosName) {
			return nil, fmt.Errorf("invalid network name %q", s.NetbiosName)
		}
		lines = append(lines, "netbios name = "+s.NetbiosName)
	}
	if s.Workgroup != "" {
		if !reNetbiosName.MatchString(s.Workgroup) {
			return nil, fmt.Errorf("invalid workgroup %q", s.Workgroup)
		}
		lines = append(lines, "workgroup = "+s.Workgroup)
	}
	switch s.MinProtocol {
	case "", "SMB2":
		lines = append(lines, "server min protocol = SMB2")
	case "SMB3":
		lines = append(lines, "server min protocol = SMB3")
	default:
		return nil, fmt.Errorf("invalid minimum protocol %q", s.MinProtocol)
	}
	switch s.Encryption {
	case "", "off":
	case "desired", "required":
		lines = append(lines, "server smb encrypt = "+s.Encryption)
	default:
		return nil, fmt.Errorf("invalid encryption %q", s.Encryption)
	}
	var deny []string
	for _, h := range s.HostsDeny {
		// A bad entry is dropped: one stored value must never stop every sync.
		ip := net.ParseIP(h)
		if ip == nil || ip.IsLoopback() {
			continue
		}
		deny = append(deny, ip.String())
	}
	if len(deny) > 0 {
		lines = append(lines, "hosts deny = "+strings.Join(deny, " "))
	}
	if s.Audit {
		lines = append(lines, "logging = file", "log file = "+smbLogPath, "log level = 1 auth_json_audit:3")
	}
	return lines, nil
}

func anyTimeMachine(shares []shareDef) bool {
	for _, s := range shares {
		if s.TimeMachine {
			return true
		}
	}
	return false
}

// timeMachineNames are the shares announced to Time Machine over mDNS.
func timeMachineNames(shares []shareDef) []string {
	var out []string
	for _, s := range shares {
		if s.TimeMachine && !s.Unavailable {
			out = append(out, s.Name)
		}
	}
	sort.Strings(out)
	return out
}

// auditShareLines log share connects (and refused connects) with who, from
// where and to which share; nothing about files.
// The first line is replaced when other modules join full_audit.
var auditShareLines = []string{
	"vfs objects = full_audit",
	"full_audit:prefix = %u|%I|%m|%S",
	"full_audit:success = connect disconnect",
	"full_audit:failure = connect",
	"full_audit:syslog = false",
}

func smbdInstalled() bool {
	if _, err := exec.LookPath("smbd"); err == nil {
		return true
	}
	_, err := os.Stat("/usr/sbin/smbd")
	return err == nil
}

// ── Share group + directory permissions ─────────────────────────────────────
// Best-effort: a failure here must not break the smb.conf write / smbd reload,
// so callers log and continue.

func ensureShareGroup() error {
	// -f: succeed if the group already exists.
	return command("groupadd", "-f", shareGroup).Run()
}

// setShareGroupMembers replaces the group's member roster with exactly `users`
// (gpasswd -M). Empty list clears membership.
func setShareGroupMembers(users []string) error {
	valid := shareGroupRoster(users, func(u string) bool { _, err := user.Lookup(u); return err == nil })
	return command("gpasswd", "-M", strings.Join(valid, ","), shareGroup).Run()
}

// shareGroupRoster keeps the names that can join the share group: never root
// or an invalid name, and only accounts that exist here. gpasswd -M refuses
// the whole list over one unknown name, which would take write access away
// from everyone because one HSI account has no Linux account.
func shareGroupRoster(users []string, exists func(string) bool) []string {
	valid := make([]string, 0, len(users))
	for _, u := range users {
		if u == "root" || !reLinuxUsername.MatchString(u) {
			continue
		}
		if !exists(u) {
			log.Printf("sharing: %q has no Linux account here; left out of %s", u, shareGroup)
			continue
		}
		valid = append(valid, u)
	}
	return valid
}

// prepareShareDir makes a writable share's directory group-owned by shareGroup,
// setgid (so new content inherits the group) and group-writable, without changing
// its owner. Pre-existing files keep their ownership.
func prepareShareDir(path string) error {
	// Defense in depth: only operate on absolute paths (also stops `path` from
	// being read as a chgrp option). Callers already validate via renderSmbConf,
	// but don't rely on call ordering.
	if !filepath.IsAbs(path) {
		return fmt.Errorf("refusing non-absolute share path %q", path)
	}
	// `--` terminates options so a path can never be parsed as a flag.
	if err := command("chgrp", "--", shareGroup, path).Run(); err != nil {
		return err
	}
	// 2775 = setgid + rwxrwxr-x
	return os.Chmod(path, 0o775|os.ModeSetgid)
}

func handleSharingCheckPrereqs(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"smbdInstalled": smbdInstalled()})
}

func renderSmbConf(shares []shareDef, settings smbSettings) (string, error) {
	globals, err := settings.globalLines()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("# Managed by nasui root-worker. Do not edit; regenerated on every sync.\n")
	b.WriteString("[global]\n")
	b.WriteString("   server role = standalone server\n")
	for _, l := range globals {
		b.WriteString("   " + l + "\n")
	}
	b.WriteString("   map to guest = Bad User\n")
	b.WriteString("   load printers = no\n")
	b.WriteString("   printing = bsd\n")
	b.WriteString("   disable spoolss = yes\n")
	if anyTimeMachine(shares) {
		// macOS metadata in streams, as Apple's own servers keep it.
		b.WriteString("   fruit:metadata = stream\n")
		b.WriteString("   fruit:model = MacSamba\n")
	}
	sorted := append([]shareDef(nil), shares...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	for _, s := range sorted {
		if !reSmbShareName.MatchString(s.Name) {
			return "", fmt.Errorf("invalid share name %q", s.Name)
		}
		// Samba expands %-variables (%u, %m, …) inside path values at connect
		// time, so a literal % in a share path could redirect what gets served.
		if !filepath.IsAbs(s.Path) || strings.ContainsAny(s.Path, "\n\r%") {
			return "", fmt.Errorf("invalid share path %q", s.Path)
		}
		for _, u := range append(append([]string(nil), s.ValidUsers...), s.WriteUsers...) {
			if !reLinuxUsername.MatchString(u) {
				return "", fmt.Errorf("invalid username %q in share %q", u, s.Name)
			}
		}
		b.WriteString("\n[" + s.Name + "]\n")
		b.WriteString("   path = " + s.Path + "\n")
		if s.Hidden {
			b.WriteString("   browseable = no\n")
		} else {
			b.WriteString("   browseable = yes\n")
		}
		var vfs []string
		if s.TimeMachine {
			vfs = append(vfs, "catia", "fruit", "streams_xattr")
		}
		if settings.Audit {
			vfs = append(vfs, "full_audit")
		}
		if len(vfs) > 0 {
			b.WriteString("   vfs objects = " + strings.Join(vfs, " ") + "\n")
		}
		if settings.Audit {
			for _, l := range auditShareLines[1:] {
				b.WriteString("   " + l + "\n")
			}
		}
		if s.TimeMachine {
			b.WriteString("   fruit:time machine = yes\n")
			if s.TimeMachineMaxGb > 0 {
				b.WriteString("   fruit:time machine max size = " + strconv.Itoa(s.TimeMachineMaxGb) + "G\n")
			}
		}
		// A place's trash (#200) is only reached from the file manager.
		b.WriteString("   veto files = /" + trashDirName + "/\n")
		if s.Unavailable {
			b.WriteString("   available = no\n")
		}
		// Writes are granted exclusively through "write list"; the share
		// itself always stays "read only = yes".
		b.WriteString("   read only = yes\n")
		if s.GuestOk {
			b.WriteString("   guest ok = yes\n")
		} else if len(s.ValidUsers) > 0 {
			b.WriteString("   valid users = " + strings.Join(s.ValidUsers, " ") + "\n")
		} else if !s.Unavailable {
			// An empty "valid users" list means "everyone" to Samba, so a share
			// with no permitted users and no guest access must be disabled.
			b.WriteString("   available = no\n")
		}
		if !s.ReadOnly && len(s.WriteUsers) > 0 {
			b.WriteString("   write list = " + strings.Join(s.WriteUsers, " ") + "\n")
			// New content is owned by the writer but group-owned by shareGroup and
			// group-writable, so any write-user can modify it (matches the setgid
			// group-writable share dir + web file-manager behaviour).
			b.WriteString("   force group = " + shareGroup + "\n")
			b.WriteString("   create mask = 0664\n")
			b.WriteString("   directory mask = 0775\n")
		}
	}
	return b.String(), nil
}

// handleSharingPlaceAccess ensures the filesystem access layer for every place
// that has write-users: the hsi-share group's members (union of all write-users)
// and each place directory made group-owned + setgid + group-writable. This lets
// BOTH SMB and the web file-manager (which write as the connecting user) write,
// even for places without an SMB share. Not gated on smbd. Best-effort.
type placeAccessDef struct {
	Path       string   `json:"path"`
	WriteUsers []string `json:"writeUsers"`
}

// placesHaveWriters: some Place gives someone write access, so the share
// group must exist.
func placesHaveWriters(places []placeAccessDef) bool {
	for _, p := range places {
		if len(p.WriteUsers) > 0 {
			return true
		}
	}
	return false
}

func handleSharingPlaceAccess(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Places []placeAccessDef `json:"places"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	// No Place has writers (a fresh install): leave the group uncreated, so a
	// configuration restore can create it with the gid of the backup.
	if !placesHaveWriters(req.Places) {
		if _, err := user.LookupGroup(shareGroup); err == nil {
			if err := setShareGroupMembers(nil); err != nil {
				log.Printf("sharing: set group members: %v", err)
			}
		}
		replyOk(nc, msg.Reply, map[string]any{"ok": true})
		return
	}
	if err := ensureShareGroup(); err != nil {
		log.Printf("sharing: ensure group %q: %v", shareGroup, err)
	}
	union := map[string]bool{}
	for _, p := range req.Places {
		if len(p.WriteUsers) == 0 {
			continue
		}
		for _, u := range p.WriteUsers {
			union[u] = true
		}
		if err := prepareShareDir(p.Path); err != nil {
			log.Printf("sharing: prepare dir %q: %v", p.Path, err)
		}
	}
	members := make([]string, 0, len(union))
	for u := range union {
		members = append(members, u)
	}
	if err := setShareGroupMembers(members); err != nil {
		log.Printf("sharing: set group members: %v", err)
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

// handleSharingPreparePlace gives a new Place's folder to the share group,
// setgid and group-writable, like the Places that have writers. The folder is
// opened once without following any symlink, on any part of the path, and
// changed through that handle: what is changed is what was checked.
func handleSharingPreparePlace(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || !filepath.IsAbs(req.Path) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	if err := ensureShareGroup(); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "share group: " + err.Error()})
		return
	}
	grp, err := user.LookupGroup(shareGroup)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "share group: " + err.Error()})
		return
	}
	gid, _ := strconv.Atoi(grp.Gid)
	if err := prepareDirNoSymlinks(filepath.Clean(req.Path), gid); err != nil {
		replyErr(nc, msg.Reply, mapOsErr(err))
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

// prepareDirNoSymlinks sets a directory's group and mode 2775 through a
// handle opened without following symlinks anywhere in the path.
func prepareDirNoSymlinks(path string, gid int) error {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_NO_SYMLINKS,
	})
	if errors.Is(err, unix.ENOSYS) {
		// Kernels before 5.6: the last part is still never followed, and the
		// rest of the path must already be the real one.
		if real, rerr := filepath.EvalSymlinks(path); rerr != nil || real != path {
			return &os.PathError{Op: "open", Path: path, Err: unix.ELOOP}
		}
		fd, err = unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	}
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer unix.Close(fd)
	if err := unix.Fchown(fd, -1, gid); err != nil {
		return &os.PathError{Op: "chown", Path: path, Err: err}
	}
	if err := unix.Fchmod(fd, 0o2775); err != nil {
		return &os.PathError{Op: "chmod", Path: path, Err: err}
	}
	return nil
}

func modeOctal(m os.FileMode) string {
	o := int(m.Perm())
	if m&os.ModeSetuid != 0 {
		o |= 0o4000
	}
	if m&os.ModeSetgid != 0 {
		o |= 0o2000
	}
	if m&os.ModeSticky != 0 {
		o |= 0o1000
	}
	return fmt.Sprintf("%04o", o)
}

// sambaAccountNames lists the Linux usernames that currently have a Samba
// password set (pdbedit -L), i.e. an actual Samba account, as opposed to a user
// HSI merely intends to have one for. Best-effort: an unreadable/absent pdbedit
// yields an empty set rather than an error, since callers treat "no Samba
// account" and "couldn't tell" the same way (both mean "don't rely on it").
func sambaAccountNames() []string {
	names := []string{}
	out, err := probe("pdbedit", "-L").Output()
	if err != nil {
		return names
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		name := line
		if i := strings.IndexByte(line, ':'); i >= 0 {
			name = line[:i]
		}
		names = append(names, name)
	}
	return names
}

// handleSharingDiag returns read-only facts for the sharing diagnostics UI: the
// accounts that have a Samba password (pdbedit -L) and the on-disk state of each
// share/place directory (group, mode, setgid, group-writable).
func handleSharingDiag(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Paths []string `json:"paths"`
	}
	_ = json.Unmarshal(msg.Data, &req)

	sambaUsers := sambaAccountNames()

	type dirState struct {
		Path          string `json:"path"`
		Exists        bool   `json:"exists"`
		Group         string `json:"group"`
		Mode          string `json:"mode"`
		Setgid        bool   `json:"setgid"`
		GroupWritable bool   `json:"groupWritable"`
	}
	dirs := make([]dirState, 0, len(req.Paths))
	for _, p := range req.Paths {
		st := dirState{Path: p}
		if fi, err := os.Stat(p); err == nil {
			st.Exists = true
			m := fi.Mode()
			st.Mode = modeOctal(m)
			st.Setgid = m&os.ModeSetgid != 0
			st.GroupWritable = m.Perm()&0o020 != 0
			if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
				gid := strconv.FormatUint(uint64(sys.Gid), 10)
				if g, err := user.LookupGroupId(gid); err == nil {
					st.Group = g.Name
				} else {
					st.Group = gid
				}
			}
		}
		dirs = append(dirs, st)
	}
	replyOk(nc, msg.Reply, map[string]any{"sambaUsers": sambaUsers, "dirs": dirs})
}

func handleSharingSync(nc *nats.Conn, msg *nats.Msg) {
	smbMu.Lock()
	defer smbMu.Unlock()
	p, fe := planSmbSync(msg.Data)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	results, ok, _ := p.execute()
	if !ok {
		for i, r := range results {
			if r.Status == "failed" {
				replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: p.Steps[i].Summary + ": " + r.Error})
				return
			}
		}
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleSharingSetPassword(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		LinuxUsername string `json:"linuxUsername"`
		Password      string `json:"password"`
		// SkipSamba: the HSI account has sambaEnabled=false: leave any existing
		// Samba account untouched rather than resetting its password (see
		// user.service.ts's sambaEnabled handling for why this doesn't remove one).
		SkipSamba bool `json:"skipSamba"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	if !reLinuxUsername.MatchString(req.LinuxUsername) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid linux username"})
		return
	}
	if req.Password == "" || strings.ContainsAny(req.Password, "\n\r") {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid password"})
		return
	}
	// Also covers the login backfill and the direct user.create path.
	if err := checkPasswordTarget(req.LinuxUsername); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	// Linux system password. The account keeps its /sbin/nologin shell (see
	// handleLinuxUserCreate), so this grants no shell/SSH access; it only
	// keeps web/Linux/Samba passwords consistent, NAS-style.
	linuxOk := true
	chp := command("chpasswd")
	chp.Stdin = strings.NewReader(req.LinuxUsername + ":" + req.Password + "\n")
	if err := chp.Run(); err != nil {
		linuxOk = false
	}
	smbOk := false
	if !req.SkipSamba {
		if _, err := exec.LookPath("smbpasswd"); err == nil {
			smb := command("smbpasswd", "-s", "-a", req.LinuxUsername)
			smb.Stdin = strings.NewReader(req.Password + "\n" + req.Password + "\n")
			smbOk = smb.Run() == nil
		}
	}
	replyOk(nc, msg.Reply, map[string]any{"linuxOk": linuxOk, "smbOk": smbOk, "smbSkipped": req.SkipSamba})
}

func handleSharingStatus(nc *nats.Conn, msg *nats.Msg) {
	if _, err := exec.LookPath("smbstatus"); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"})
		return
	}
	out, err := smbStatusJSON()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "smbstatus failed: " + err.Error()})
		return
	}
	connections, err := parseSmbStatus(out)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "unexpected smbstatus output"})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"connections": connections})
}
