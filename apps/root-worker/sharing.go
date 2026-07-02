package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// SMB sharing handlers. The app owns /etc/nasui/samba/smb.conf and points
// smbd at it through a systemd drop-in — the samba package's own
// /etc/samba/smb.conf is never modified, so apt upgrades stay conflict-free
// (no dpkg-divert, no conffile prompt).
const (
	smbConfDir  = "/etc/nasui/samba"
	smbConfPath = smbConfDir + "/smb.conf"
	dropInDir   = "/etc/systemd/system/smbd.service.d"
	dropInPath  = dropInDir + "/nasui.conf"
)

const dropInContent = `# Managed by nasui — points smbd at the app-owned config instead of the
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
}

func smbdInstalled() bool {
	if _, err := exec.LookPath("smbd"); err == nil {
		return true
	}
	_, err := os.Stat("/usr/sbin/smbd")
	return err == nil
}

func handleSharingCheckPrereqs(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"smbdInstalled": smbdInstalled()})
}

// ensureDropIn installs the systemd drop-in once. Returns true when it was
// just created (caller must daemon-reload + restart instead of reload).
func ensureDropIn() (bool, error) {
	if _, err := os.Stat(dropInPath); err == nil {
		return false, nil
	}
	if err := os.MkdirAll(dropInDir, 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(dropInPath, []byte(dropInContent), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

func renderSmbConf(shares []shareDef) (string, error) {
	var b strings.Builder
	b.WriteString("# Managed by nasui root-worker — do not edit; regenerated on every sync.\n")
	b.WriteString("[global]\n")
	b.WriteString("   server role = standalone server\n")
	b.WriteString("   server min protocol = SMB2\n")
	b.WriteString("   map to guest = Bad User\n")
	b.WriteString("   load printers = no\n")
	b.WriteString("   printing = bsd\n")
	b.WriteString("   disable spoolss = yes\n")
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
		b.WriteString("   browseable = yes\n")
		// Writes are granted exclusively through "write list" — the share
		// itself always stays "read only = yes".
		b.WriteString("   read only = yes\n")
		if s.GuestOk {
			b.WriteString("   guest ok = yes\n")
		} else if len(s.ValidUsers) > 0 {
			b.WriteString("   valid users = " + strings.Join(s.ValidUsers, " ") + "\n")
		} else {
			// An empty "valid users" list means "everyone" to Samba — a share
			// with no permitted users and no guest access must be disabled.
			b.WriteString("   available = no\n")
		}
		if !s.ReadOnly && len(s.WriteUsers) > 0 {
			b.WriteString("   write list = " + strings.Join(s.WriteUsers, " ") + "\n")
		}
	}
	return b.String(), nil
}

func handleSharingSync(nc *nats.Conn, msg *nats.Msg) {
	if !smbdInstalled() {
		replyErr(nc, msg.Reply, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"})
		return
	}
	var req struct {
		Shares []shareDef `json:"shares"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	conf, err := renderSmbConf(req.Shares)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	created, err := ensureDropIn()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "install drop-in: " + err.Error()})
		return
	}
	if err := os.MkdirAll(smbConfDir, 0o755); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	tmp := smbConfPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(conf), 0o644); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := os.Rename(tmp, smbConfPath); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if created {
		if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
			return
		}
		exec.Command("systemctl", "enable", "--quiet", "smbd").Run()
		if out, err := exec.Command("systemctl", "restart", "smbd").CombinedOutput(); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "restart smbd: " + strings.TrimSpace(string(out))})
			return
		}
	} else {
		exec.Command("systemctl", "enable", "--quiet", "smbd").Run()
		if out, err := exec.Command("systemctl", "reload-or-restart", "smbd").CombinedOutput(); err != nil {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "reload smbd: " + strings.TrimSpace(string(out))})
			return
		}
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleSharingSetPassword(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		LinuxUsername string `json:"linuxUsername"`
		Password      string `json:"password"`
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
	// Linux system password. The account keeps its /sbin/nologin shell (see
	// handleLinuxUserCreate), so this grants no shell/SSH access — it only
	// keeps web/Linux/Samba passwords consistent, NAS-style.
	linuxOk := true
	chp := exec.Command("chpasswd")
	chp.Stdin = strings.NewReader(req.LinuxUsername + ":" + req.Password + "\n")
	if err := chp.Run(); err != nil {
		linuxOk = false
	}
	smbOk := false
	if _, err := exec.LookPath("smbpasswd"); err == nil {
		smb := exec.Command("smbpasswd", "-s", "-a", req.LinuxUsername)
		smb.Stdin = strings.NewReader(req.Password + "\n" + req.Password + "\n")
		smbOk = smb.Run() == nil
	}
	replyOk(nc, msg.Reply, map[string]any{"linuxOk": linuxOk, "smbOk": smbOk})
}

func handleSharingStatus(nc *nats.Conn, msg *nats.Msg) {
	if _, err := exec.LookPath("smbstatus"); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"})
		return
	}
	out, err := exec.Command("smbstatus", "--json").Output()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "smbstatus failed: " + err.Error()})
		return
	}
	var raw struct {
		Sessions map[string]struct {
			Username      string `json:"username"`
			RemoteMachine string `json:"remote_machine"`
			Hostname      string `json:"hostname"`
		} `json:"sessions"`
		Tcons map[string]struct {
			Service     string `json:"service"`
			SessionID   string `json:"session_id"`
			Machine     string `json:"machine"`
			ConnectedAt string `json:"connected_at"`
		} `json:"tcons"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "unexpected smbstatus output"})
		return
	}
	type connection struct {
		User        string `json:"user"`
		Share       string `json:"share"`
		Client      string `json:"client"`
		ConnectedAt string `json:"connectedAt"`
	}
	connections := []connection{}
	for _, t := range raw.Tcons {
		if t.Service == "IPC$" {
			continue
		}
		c := connection{Share: t.Service, Client: t.Machine, ConnectedAt: t.ConnectedAt}
		if s, ok := raw.Sessions[t.SessionID]; ok {
			c.User = s.Username
			if c.Client == "" {
				c.Client = s.RemoteMachine
			}
		}
		connections = append(connections, c)
	}
	replyOk(nc, msg.Reply, map[string]any{"connections": connections})
}
