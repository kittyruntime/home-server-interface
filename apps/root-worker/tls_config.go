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
	case err != nil || perr != nil || !info.FromAuthority:
		reason = "missing"
	case info.NotAfter.Sub(now) < 30*24*time.Hour:
		reason = "expiring"
	case strings.Join(names, ",") != strings.Join(c.IssuedFor, ","):
		reason = "names"
	default:
		return false, "", nil
	}
	if _, err := issueServerCert(currentTLSNames(), now); err != nil {
		return false, reason, err
	}
	c.IssuedFor = names
	return true, reason, saveTLSConfig(c)
}

func handleTLSStatus(nc *nats.Conn, msg *nats.Msg) { replyOk(nc, msg.Reply, tlsStatus(time.Now())) }

// tlsIssue renews the local certificate when needed. With force and the mode
// "imported" (the backend cannot load the imported certificate), it falls back
// to the local authority: the mode becomes local and a certificate is issued.
func tlsIssue(now time.Time, force bool) (bool, string, error) {
	if force {
		if c := loadTLSConfig(); c.Mode == "imported" {
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

func flagPort(args []string, def int) (int, error) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--port" {
			p, err := strconv.Atoi(args[i+1])
			if err != nil || p < 1 || p > 65535 {
				return 0, fmt.Errorf("invalid port")
			}
			return p, nil
		}
	}
	return def, nil
}

// runTLSCLI is `hsi-worker tls init|migrate|reset|fingerprint`.
func runTLSCLI(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: hsi-worker tls init|migrate|reset|fingerprint [--port N]")
		return 2
	}
	now := time.Now()
	port, err := flagPort(args[1:], loadTLSConfig().Port)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	switch args[0] {
	case "init":
		if _, err := os.Stat(tlsConfigPath()); err == nil {
			_, _, err := renewLocalIfNeeded(now)
			return exitOn(err)
		}
		if err := saveTLSConfig(tlsConfig{Mode: "local", Port: port}); err != nil {
			return exitOn(err)
		}
		_, _, err := renewLocalIfNeeded(now)
		return exitOn(err)
	case "migrate":
		if _, err := os.Stat(tlsConfigPath()); err == nil {
			return 0
		}
		mode := "off"
		if fileExists(nginxSitePath) {
			mode = "proxy"
		}
		return exitOn(saveTLSConfig(tlsConfig{Mode: mode, Port: port}))
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
