package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	nats "github.com/nats-io/nats.go"
)

// buildVersion is set at build time: -ldflags "-X main.buildVersion=vX.Y.Z".
var buildVersion = "dev"

// ── Safe updates (#9a): health gate ──────────────────────────────────────────
// After a switch, HSI is healthy when the server's /health answers 200 with the
// database up and the expected version, and the worker answers root.health.

// firstHealthVersion is the first release whose /health reports db and version and
// whose worker answers root.health. Rolling back to an older one checks what it has.
const firstHealthVersion = "v1.67.0"

// Polling of the health gate; tests shorten them.
var (
	healthTimeout  = 120 * time.Second
	healthInterval = 2 * time.Second
)

type healthTarget struct {
	URL        string
	CAFile     string // PEM roots for https; never skip verification
	ServerName string // name checked in the certificate, when not the URL host
	Version    string
	Timeout    time.Duration
	Interval   time.Duration
	Legacy     bool // a version before firstHealthVersion
}

// healthTargetFor builds the probe of version from tls.json: plain http, or https
// trusting the local authority (local) or the served certificate itself (imported).
func healthTargetFor(version string) healthTarget {
	c := loadTLSConfig()
	t := healthTarget{
		URL: fmt.Sprintf("http://127.0.0.1:%d/health", c.Port), Version: version,
		Timeout: healthTimeout, Interval: healthInterval,
		Legacy: compareVersions(version, firstHealthVersion) < 0,
	}
	switch c.Mode {
	case "local":
		t.URL = fmt.Sprintf("https://127.0.0.1:%d/health", c.Port)
		t.CAFile = filepath.Join(tlsDir(), "ca.crt")
	case "imported":
		// An imported certificate is rarely issued for 127.0.0.1: pin the served
		// certificate and check one of its own names.
		t.URL = fmt.Sprintf("https://127.0.0.1:%d/health", c.Port)
		t.CAFile = filepath.Join(tlsDir(), "server.crt")
		t.ServerName = certificateName(t.CAFile)
	}
	return t
}

func certificateName(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return ""
	}
	c, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return ""
	}
	if len(c.DNSNames) > 0 {
		return c.DNSNames[0]
	}
	if len(c.IPAddresses) > 0 {
		return c.IPAddresses[0].String()
	}
	return ""
}

// httpHealth is one probe of the server's /health.
var httpHealth = func(t healthTarget) error {
	timeout := 5 * time.Second
	if t.Timeout > 0 && t.Timeout < timeout {
		timeout = t.Timeout
	}
	transport := &http.Transport{Proxy: nil}
	if t.CAFile != "" {
		pemBytes, err := os.ReadFile(t.CAFile)
		if err != nil {
			return fmt.Errorf("read the certificate authority: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pemBytes) {
			return fmt.Errorf("%s holds no certificate", t.CAFile)
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: t.ServerName, MinVersion: tls.VersionTLS12}
	}
	client := &http.Client{
		Timeout:   timeout,
		Transport: transport,
		// A redirect (plain HTTP on an https port) is an answer, not a health report.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer transport.CloseIdleConnections()
	resp, err := client.Get(t.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("/health answered HTTP %d", resp.StatusCode)
	}
	var h struct {
		Status  string  `json:"status"`
		DB      *bool   `json:"db"`
		Version *string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&h); err != nil {
		return fmt.Errorf("/health is not JSON: %w", err)
	}
	if h.Status != "ok" {
		return fmt.Errorf("/health reports status %q", h.Status)
	}
	if t.Legacy && h.Version == nil {
		return nil
	}
	if h.DB == nil || !*h.DB {
		return errors.New("/health reports the database unreachable")
	}
	if h.Version == nil {
		return errors.New("/health does not report a version")
	}
	if *h.Version != t.Version {
		return fmt.Errorf("/health reports version %s, expected %s", *h.Version, t.Version)
	}
	return nil
}

// natsHealth asks the worker for root.health; an answer also proves the broker is up.
var natsHealth = func() error {
	url, user, pass := workerNATSCredentials()
	nc, err := nats.Connect(url, nats.UserInfo(user, pass), nats.Timeout(3*time.Second), nats.NoReconnect())
	if err != nil {
		return fmt.Errorf("connect to NATS: %w", err)
	}
	defer nc.Close()
	msg, err := nc.Request("root.health", nil, 3*time.Second)
	if err != nil {
		return fmt.Errorf("root.health: %w", err)
	}
	var r struct {
		Ok bool `json:"ok"`
	}
	if json.Unmarshal(msg.Data, &r) != nil || !r.Ok {
		return errors.New("root.health answered without ok")
	}
	return nil
}

// workerNATSCredentials reads NATS_URL/USER/PASS from the environment, else from
// worker.env (a CLI run from a shell or the installer has no EnvironmentFile).
func workerNATSCredentials() (url, user, pass string) {
	file := map[string]string{}
	if os.Getenv("NATS_PASS") == "" {
		file = readEnvFile(workerEnvPath())
	}
	pick := func(k, def string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		if v := file[k]; v != "" {
			return v
		}
		return def
	}
	return pick("NATS_URL", "nats://127.0.0.1:4222"), pick("NATS_USER", "worker"), pick("NATS_PASS", "worker-dev")
}

func readEnvFile(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return out
}

// workerUnitActive replaces root.health for a legacy version.
func workerUnitActive() error {
	if out, err := systemctl("is-active", "--quiet", unitPrefix()+"-worker.service"); err != nil {
		return fmt.Errorf("%s-worker.service is not active: %s", unitPrefix(), cmdErrMessage(out, err))
	}
	return nil
}

// waitHealthy polls both checks until they pass together or Timeout ends; the error
// names the checks that failed last ("server", "worker").
func waitHealthy(t healthTarget) error {
	interval := t.Interval
	if interval <= 0 {
		interval = healthInterval
	}
	deadline := time.Now().Add(t.Timeout)
	for {
		var failed []string
		if err := httpHealth(t); err != nil {
			failed = append(failed, "server: "+err.Error())
		}
		worker := natsHealth
		if t.Legacy {
			worker = workerUnitActive
		}
		if err := worker(); err != nil {
			failed = append(failed, "worker: "+err.Error())
		}
		if len(failed) == 0 {
			return nil
		}
		if !time.Now().Add(interval).Before(deadline) {
			return fmt.Errorf("%s is not healthy after %s: %s", t.Version, t.Timeout, strings.Join(failed, "; "))
		}
		time.Sleep(interval)
	}
}

func rootHealthReply() []byte {
	b, _ := json.Marshal(map[string]any{"ok": true, "version": buildVersion})
	return b
}

// handleRootHealth answers the health gate: {"ok":true,"version":...}.
func handleRootHealth(nc *nats.Conn, msg *nats.Msg) {
	if msg.Reply != "" {
		_ = nc.Publish(msg.Reply, rootHealthReply())
	}
}
