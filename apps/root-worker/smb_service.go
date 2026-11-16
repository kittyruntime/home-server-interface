package main

import (
	"encoding/json"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// SMB service state, sessions, disconnect and network discovery. Commands go
// through smbRun and smbStatusJSON so tests never touch the machine.
var (
	smbRun        = func(name string, args ...string) error { return command(name, args...).Run() }
	smbStatusJSON = func() ([]byte, error) { return probe("smbstatus", "--json").Output() }
	smbBuildInfo  = func() string { o, _ := probe("smbd", "-b").Output(); return string(o) }

	avahiServicesDir = "/etc/avahi/services"
)

const avahiServiceName = "hsi-smb.service"

type smbConnection struct {
	User        string `json:"user"`
	Share       string `json:"share"`
	Client      string `json:"client"`
	ConnectedAt string `json:"connectedAt"`
	Pid         string `json:"pid"`
	IP          string `json:"ip"`
	SessionID   string `json:"sessionId"`
}

var rePid = regexp.MustCompile(`^[0-9]+$`)

func parseSmbStatus(b []byte) ([]smbConnection, error) {
	type serverID struct {
		Pid string `json:"pid"`
	}
	var raw struct {
		Sessions map[string]struct {
			Username      string   `json:"username"`
			RemoteMachine string   `json:"remote_machine"`
			Hostname      string   `json:"hostname"`
			ServerID      serverID `json:"server_id"`
		} `json:"sessions"`
		Tcons map[string]struct {
			Service     string   `json:"service"`
			SessionID   string   `json:"session_id"`
			Machine     string   `json:"machine"`
			ConnectedAt string   `json:"connected_at"`
			ServerID    serverID `json:"server_id"`
		} `json:"tcons"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	out := []smbConnection{}
	for _, t := range raw.Tcons {
		if t.Service == "IPC$" {
			continue
		}
		c := smbConnection{Share: t.Service, Client: t.Machine, ConnectedAt: t.ConnectedAt, Pid: t.ServerID.Pid, SessionID: t.SessionID}
		if s, ok := raw.Sessions[t.SessionID]; ok {
			c.User = s.Username
			c.IP = smbAddr(s.Hostname)
			if c.Client == "" {
				c.Client = s.RemoteMachine
			}
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ConnectedAt < out[j].ConnectedAt })
	return out, nil
}

// disconnectSmbSession ends the smbd process serving a session; a pid that
// is not one of smbstatus's sessions is refused.
func disconnectSmbSession(pid string) *fsError {
	notASession := &fsError{Code: "NOT_A_SESSION", Message: "no SMB session has this process id"}
	if !rePid.MatchString(pid) {
		return notASession
	}
	b, err := smbStatusJSON()
	if err != nil {
		return &fsError{Code: "ERR", Message: "smbstatus failed: " + err.Error()}
	}
	conns, err := parseSmbStatus(b)
	if err != nil {
		return &fsError{Code: "ERR", Message: "unexpected smbstatus output"}
	}
	for _, c := range conns {
		if c.Pid == pid {
			if err := smbRun("smbcontrol", pid, "shutdown"); err != nil {
				return &fsError{Code: "ERR", Message: "could not end the session: " + err.Error()}
			}
			return nil
		}
	}
	return notASession
}

func smbServiceAction(action string) *fsError {
	if action != "start" && action != "restart" {
		return &fsError{Code: "ERR", Message: "unknown action"}
	}
	if err := smbRun("systemctl", action, "smbd"); err != nil {
		return &fsError{Code: "ERR", Message: "systemctl " + action + " smbd failed: " + err.Error()}
	}
	return nil
}

// smbAuditSupported: JSON audit needs jansson; vfs_full_audit is either
// built in or a module under MODULESDIR.
func smbAuditSupported(buildInfo string, fullAuditModule bool) bool {
	return strings.Contains(buildInfo, "HAVE_JANSSON") &&
		(fullAuditModule || strings.Contains(buildInfo, "vfs_full_audit_init"))
}

func smbModulesDir(buildInfo string) string {
	for _, l := range strings.Split(buildInfo, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "MODULESDIR:"); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// wsddUnit is the WS-Discovery daemon present on the host, if any.
func wsddUnit() string {
	for _, n := range []string{"wsdd", "wsdd2"} {
		if hostLookPath(n) {
			return n
		}
	}
	return ""
}

func avahiServiceFile(name string) string {
	n := `<name replace-wildcards="yes">%h</name>`
	if name != "" {
		n = "<name>" + html.EscapeString(name) + "</name>"
	}
	return `<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Managed by HSI: announces the SMB shares to macOS. -->
<service-group>
  ` + n + `
  <service>
    <type>_smb._tcp</type>
    <port>445</port>
  </service>
</service-group>
`
}

// applySmbDiscovery turns the announcements that are asked about on or off
// (nil leaves one as it is, so a wsdd the admin runs is never touched by an
// unrelated change). Turning one off only removes what HSI added.
func applySmbDiscovery(wsd, mdns *bool, name string) *fsError {
	if wsd != nil {
		unit := wsddUnit()
		switch {
		case unit != "":
			verb := "disable"
			if *wsd {
				verb = "enable"
			}
			if err := smbRun("systemctl", verb, "--now", unit); err != nil {
				return &fsError{Code: "ERR", Message: "systemctl " + verb + " " + unit + " failed: " + err.Error()}
			}
		case *wsd:
			return &fsError{Code: "TOOL_MISSING", Message: "wsdd is not installed"}
		}
	}
	if mdns == nil {
		return nil
	}
	path := filepath.Join(avahiServicesDir, avahiServiceName)
	if !*mdns {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return &fsError{Code: "ERR", Message: err.Error()}
		}
		return nil
	}
	if !hostLookPath("avahi-daemon") {
		return &fsError{Code: "TOOL_MISSING", Message: "Avahi is not installed"}
	}
	if err := os.MkdirAll(avahiServicesDir, 0o755); err != nil {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
	if err := writeFileAtomic(path, []byte(avahiServiceFile(name)), 0o644); err != nil {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
	return nil
}

func handleSharingService(nc *nats.Conn, msg *nats.Msg) {
	res := map[string]any{"installed": smbdInstalled(), "active": false, "version": "", "audit": false,
		"wsdd": wsddUnit(), "avahi": hostLookPath("avahi-daemon"), "wsddOn": false, "avahiOn": false}
	if unit := res["wsdd"].(string); unit != "" {
		res["wsddOn"] = smbRun("systemctl", "is-enabled", "--quiet", unit) == nil
	}
	_, err := os.Stat(filepath.Join(avahiServicesDir, avahiServiceName))
	res["avahiOn"] = err == nil
	if res["installed"].(bool) {
		res["active"] = smbRun("systemctl", "is-active", "--quiet", "smbd") == nil
		if o, err := probe("smbd", "-V").Output(); err == nil {
			res["version"] = strings.TrimSpace(strings.TrimPrefix(string(o), "Version "))
		}
		info := smbBuildInfo()
		dir := smbModulesDir(info)
		res["audit"] = smbAuditSupported(info, dir != "" && hostExists(filepath.Join(dir, "vfs", "full_audit.so")))
	}
	replyOk(nc, msg.Reply, res)
}

func handleSharingServiceAction(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	if fe := smbServiceAction(req.Action); fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleSharingDisconnect(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Pid string `json:"pid"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	if fe := disconnectSmbSession(req.Pid); fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleSharingDiscovery(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Wsd  *bool  `json:"wsd"`
		Mdns *bool  `json:"mdns"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	if fe := applySmbDiscovery(req.Wsd, req.Mdns, req.Name); fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}
