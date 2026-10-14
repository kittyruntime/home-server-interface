package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	nats "github.com/nats-io/nats.go"
)

// ── Managed HTTPS (#12): configuration ───────────────────────────────────────
// tls.json says how the backend serves: local (the local authority's
// certificate), imported, proxy (plain HTTP behind the admin's proxy) or off
// (plain HTTP, as before). The backend reads it at start; the worker writes it.

var nginxSitePath = "/etc/nginx/sites-available/hsi"

type tlsConfig struct {
	Mode           string   `json:"mode"`
	Port           int      `json:"port"`
	StandardPorts  bool     `json:"standardPorts"`
	TrustedProxies []string `json:"trustedProxies"`
	IssuedFor      []string `json:"issuedFor"`
	Group          string   `json:"group,omitempty"`
}

func tlsConfigPath() string { return filepath.Join(tlsDir(), "tls.json") }

func loadTLSConfig() tlsConfig {
	c := tlsConfig{Mode: "off", Port: 9001}
	b, err := os.ReadFile(tlsConfigPath())
	if err != nil || json.Unmarshal(b, &c) != nil {
		return tlsConfig{Mode: "off", Port: 9001}
	}
	switch c.Mode {
	case "local", "imported", "proxy", "off":
	default:
		c.Mode = "off"
	}
	if c.Port < 1 || c.Port > 65535 {
		c.Port = 9001
	}
	if c.TrustedProxies == nil {
		c.TrustedProxies = []string{}
	}
	return c
}

func saveTLSConfig(c tlsConfig) error {
	if c.TrustedProxies == nil {
		c.TrustedProxies = []string{}
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return writeTLSFile("tls.json", append(b, '\n'), 0o644, false)
}

func tlsStatus(now time.Time) map[string]any {
	c := loadTLSConfig()
	st := map[string]any{"mode": c.Mode, "port": c.Port, "standardPorts": c.StandardPorts,
		"trustedProxies": c.TrustedProxies, "certificate": nil, "authorityFingerprint": nil, "nginxSite": fileExists(nginxSitePath)}
	if b, err := os.ReadFile(filepath.Join(tlsDir(), "server.crt")); err == nil {
		if info, err := readCertInfo(b); err == nil {
			st["certificate"] = info
		}
	}
	if fp, err := authorityFingerprint(); err == nil {
		st["authorityFingerprint"] = fp
	}
	return st
}

func renewLocalIfNeeded(now time.Time) (bool, string, error) {
	c := loadTLSConfig()
	if c.Mode != "local" {
		return false, "", nil
	}
	names := currentTLSNames().list()
	reason := ""
	b, err := os.ReadFile(filepath.Join(tlsDir(), "server.crt"))
	info, perr := readCertInfo(b)
	switch {
	case err != nil || perr != nil || !info.FromAuthority || !localPairLoads():
		reason = "missing"
	case info.NotAfter.Sub(now) < 30*24*time.Hour:
		reason = "expiring"
	case strings.Join(names, ",") != strings.Join(c.IssuedFor, ","):
		reason = "names"
	default:
		return false, "", nil
	}
	if err := issueLocal(&c, now); err != nil {
		return false, reason, err
	}
	return true, reason, nil
}

// localPairLoads tells whether server.crt and server.key form a pair the
// backend can serve (both readable, the key matching the leaf).
func localPairLoads() bool {
	crt, err1 := os.ReadFile(filepath.Join(tlsDir(), "server.crt"))
	key, err2 := os.ReadFile(filepath.Join(tlsDir(), "server.key"))
	if err1 != nil || err2 != nil {
		return false
	}
	_, err := tlsKeyPair(crt, key)
	return err == nil
}

// issueLocal issues a certificate for this server's current names and records
// them in c, then saves c.
func issueLocal(c *tlsConfig, now time.Time) error {
	names := currentTLSNames()
	if _, err := issueServerCert(names, now); err != nil {
		return err
	}
	c.IssuedFor = names.list()
	return saveTLSConfig(*c)
}

func handleTLSStatus(nc *nats.Conn, msg *nats.Msg) { replyOk(nc, msg.Reply, tlsStatus(time.Now())) }

// tlsIssue renews the local certificate when needed. With force (the backend
// cannot load the served certificate): in "imported" mode it falls back to the
// local authority (the mode becomes local and a certificate is issued); in
// "local" mode a pair that does not load is reissued.
func tlsIssue(now time.Time, force bool) (bool, string, error) {
	if force {
		c := loadTLSConfig()
		if c.Mode == "local" && !localPairLoads() {
			if err := issueLocal(&c, now); err != nil {
				return false, "fallback", err
			}
			return true, "fallback", nil
		}
		if c.Mode == "imported" {
			c.Mode, c.IssuedFor = "local", nil
			if err := saveTLSConfig(c); err != nil {
				return false, "", err
			}
			if _, _, err := renewLocalIfNeeded(now); err != nil {
				return false, "fallback", err
			}
			return true, "fallback", nil
		}
	}
	return renewLocalIfNeeded(now)
}

func handleTLSIssue(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Force bool `json:"force"`
	}
	if len(msg.Data) > 0 {
		_ = json.Unmarshal(msg.Data, &req)
	}
	renewed, reason, err := tlsIssue(time.Now(), req.Force)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"renewed": renewed, "reason": reason})
}

// restartServerLater restarts hsi-server in two seconds, from a transient unit:
// the reply of the plan that asked for it reaches the backend first.
func restartServerArgv() []string {
	return []string{"systemd-run", "--on-active=2", "--unit=hsi-server-restart-" + strconv.FormatInt(time.Now().UnixNano(), 36),
		"systemctl", "restart", "hsi-server.service"}
}

// tlsFlags reads --port N and --group NAME; port is 0 and group empty when
// they are not given.
func tlsFlags(args []string) (port int, group string, err error) {
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--port":
			p, perr := strconv.Atoi(args[i+1])
			if perr != nil || p < 1 || p > 65535 {
				return 0, "", fmt.Errorf("invalid port")
			}
			port = p
		case "--group":
			group = strings.TrimSpace(args[i+1])
			if group == "" {
				return 0, "", fmt.Errorf("invalid group")
			}
		}
	}
	return port, group, nil
}

// updateTLSConfig applies the installer's port and group to an existing tls.json.
func updateTLSConfig(port int, group string) error {
	c := loadTLSConfig()
	if port > 0 {
		c.Port = port
	}
	if group != "" {
		c.Group = group
	}
	return saveTLSConfig(c)
}

// runTLSCLI is `hsi-worker tls init|migrate|reset|fingerprint`.
func runTLSCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: hsi-worker tls init|migrate|reset|fingerprint [--port N] [--group NAME]")
		return 2
	}
	now := time.Now()
	port, group, err := tlsFlags(args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	newPort := port
	if newPort == 0 {
		newPort = 9001
	}
	_, statErr := os.Stat(tlsConfigPath())
	exists := statErr == nil
	switch args[0] {
	case "init":
		if exists {
			if err := updateTLSConfig(port, group); err != nil {
				return exitOn(err)
			}
			_, _, err := renewLocalIfNeeded(now)
			return exitOn(err)
		}
		// The group is recorded first so the key can be handed to it; local
		// mode is saved only once the certificate exists. On failure no
		// tls.json is left: the backend keeps serving plain HTTP.
		c := tlsConfig{Mode: "off", Port: newPort, Group: group}
		if err := saveTLSConfig(c); err != nil {
			return exitOn(err)
		}
		c.Mode = "local"
		if err := issueLocal(&c, now); err != nil {
			_ = os.Remove(tlsConfigPath())
			return exitOn(err)
		}
		return 0
	case "migrate":
		if exists {
			return exitOn(updateTLSConfig(port, group))
		}
		mode := "off"
		if fileExists(nginxSitePath) {
			mode = "proxy"
		}
		return exitOn(saveTLSConfig(tlsConfig{Mode: mode, Port: newPort, Group: group}))
	case "reset":
		c := loadTLSConfig()
		c.Mode, c.StandardPorts, c.IssuedFor = "local", false, nil
		if err := saveTLSConfig(c); err != nil {
			return exitOn(err)
		}
		if _, _, err := renewLocalIfNeeded(now); err != nil {
			return exitOn(err)
		}
		if out, err := runArgv([]string{"systemctl", "restart", "hsi-server.service"}); err != nil {
			fmt.Fprintln(os.Stderr, cmdErrMessage(out, err))
		}
		fp, _ := authorityFingerprint()
		fmt.Printf("HSI now serves https://%s:%d\nAuthority fingerprint (SHA-256): %s\n", firstIPv4(), c.Port, fp)
		return 0
	case "fingerprint":
		fp, err := authorityFingerprint()
		if err != nil {
			return exitOn(err)
		}
		fmt.Println(fp)
		return 0
	}
	fmt.Fprintln(os.Stderr, "unknown tls command:", args[0])
	return 2
}

func exitOn(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
