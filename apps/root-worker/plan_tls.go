package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ── Plan builders: managed HTTPS (#12) ──────────────────────────────────────

var reSSProcess = regexp.MustCompile(`users:\(\("([^"]+)"`)

// ssProcessName extracts the first process name of an `ss -ltnp` line.
func ssProcessName(out string) string {
	if m := reSSProcess.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// portHolder names what listens on a TCP port ("" when it is free). The bind
// test is the one root.sys.port.check uses; the holder is then named from ss
// and, behind docker-proxy, from the container publishing the port.
var portHolder = func(port int) string {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err == nil {
		_ = ln.Close()
		return ""
	}
	out, _ := hostOutput("ss", "-ltnpH", fmt.Sprintf("sport = :%d", port))
	name := ssProcessName(string(out))
	switch name {
	case "":
		return "another program"
	case "docker-proxy":
		o, _ := hostOutput("docker", "ps", "--filter", fmt.Sprintf("publish=%d", port), "--format", "{{.Names}}")
		if c := strings.TrimSpace(strings.SplitN(string(o), "\n", 2)[0]); c != "" {
			return "the container " + c
		}
		return "another program"
	}
	return "the process " + name
}

func tlsObserved() map[string]string {
	raw, _ := os.ReadFile(tlsConfigPath())
	fp := ""
	if b, err := os.ReadFile(filepath.Join(tlsDir(), "server.crt")); err == nil {
		if info, err := readCertInfo(b); err == nil {
			fp = info.Fingerprint
		}
	}
	return map[string]string{"tls": string(raw), "cert": fp}
}

// tlsConfigStep writes tls.json with the change, showing its diff.
func tlsConfigStep(summary string, next tlsConfig) planStep {
	before, _ := os.ReadFile(tlsConfigPath())
	after, _ := json.MarshalIndent(next, "", "  ")
	return planStep{Kind: "update", Target: tlsConfigPath(), Summary: summary,
		Diff: unifiedDiff(tlsConfigPath(), string(before), string(after)+"\n"),
		run:  func() (string, error) { return "", saveTLSConfig(next) }}
}

func tlsRestartStep() planStep {
	s := cmdStep("hsi-server", "Restart the HSI server in 2 seconds (the page reloads at the new address)", restartServerArgv())
	s.OnFailure = "warn"
	return s
}

func localCertStep(names tlsNames) planStep {
	return planStep{Kind: "create", Target: filepath.Join(tlsDir(), "server.crt"),
		Summary: "Issue a certificate for " + strings.Join(names.list(), ", ") + " from the local authority (valid 397 days)",
		run:     func() (string, error) { _, err := issueServerCert(names, time.Now()); return "", err }}
}

func tlsOn(c tlsConfig) bool { return c.Mode == "local" || c.Mode == "imported" }

func planTLSEnable(raw json.RawMessage) (*opPlan, *fsError) {
	c := loadTLSConfig()
	if tlsOn(c) {
		return nil, &fsError{Code: "ENOOP", Message: "HTTPS is already on"}
	}
	names := currentTLSNames()
	next := c
	next.Mode = "local"
	next.IssuedFor = names.list()
	return &opPlan{Op: "tls.enable", Observed: tlsObserved(), Steps: []planStep{
		localCertStep(names),
		tlsConfigStep(fmt.Sprintf("Serve HSI over HTTPS on port %d", c.Port), next),
		tlsRestartStep(),
	}}, nil
}

func planTLSUseLocal(raw json.RawMessage) (*opPlan, *fsError) {
	c := loadTLSConfig()
	if c.Mode != "imported" {
		return nil, &fsError{Code: "ENOOP", Message: "HSI already uses the local authority"}
	}
	names := currentTLSNames()
	next := c
	next.Mode = "local"
	next.IssuedFor = names.list()
	return &opPlan{Op: "tls.useLocal", Observed: tlsObserved(), Steps: []planStep{
		localCertStep(names),
		tlsConfigStep("Serve the certificate of the local authority", next),
	}}, nil
}

// certCovers reports whether one of the certificate names covers host; a
// wildcard covers exactly one label.
func certCovers(names []string, host string) bool {
	host = strings.ToLower(host)
	for _, n := range names {
		n = strings.ToLower(n)
		if n == host {
			return true
		}
		if strings.HasPrefix(n, "*.") {
			if i := strings.Index(host, "."); i > 0 && host[i:] == n[1:] {
				return true
			}
		}
	}
	return false
}

func planTLSImport(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Cert string `json:"cert"`
		Key  string `json:"key"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	info, chain, key, err := validateImport([]byte(req.Cert), []byte(req.Key), time.Now())
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	c := loadTLSConfig()
	next := c
	next.Mode = "imported"
	next.IssuedFor = nil

	steps := []planStep{
		{Kind: "update", Target: filepath.Join(tlsDir(), "server.key"), Summary: "Install the private key",
			run: func() (string, error) { return "", writeTLSFile("server.key", key, 0o640, true) }},
		{Kind: "update", Target: filepath.Join(tlsDir(), "server.crt"),
			Summary: fmt.Sprintf("Serve the certificate for %s (issued by %s, expires %s)",
				strings.Join(info.Names, ", "), info.Issuer, info.NotAfter.Format("2006-01-02")),
			run: func() (string, error) { return "", writeTLSFile("server.crt", chain, 0o644, false) }},
		tlsConfigStep("Serve HSI over HTTPS with the imported certificate", next),
	}
	if c.Mode == "off" || c.Mode == "proxy" || c.Mode == "" {
		steps = append(steps, tlsRestartStep())
	}

	host := hostHostname()
	covered := certCovers(info.Names, host) || certCovers(info.Names, host+".local")
	for _, ip := range hostAddrs() {
		if certCovers(info.Names, ip.String()) {
			covered = true
		}
	}
	reply := map[string]any{}
	if !covered {
		reply["warnings"] = []string{fmt.Sprintf(
			"The certificate does not cover %q or this server's addresses: browsers will warn unless HSI is reached by one of its names (%s)",
			host, strings.Join(info.Names, ", "))}
	}
	sum := sha256.Sum256([]byte(req.Cert + req.Key))
	return &opPlan{Op: "tls.import", Observed: tlsObserved(), Steps: steps, Reply: reply,
		FingerprintInput: json.RawMessage(fmt.Sprintf("%q", hex.EncodeToString(sum[:])))}, nil
}

func planTLSProxy(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		TrustedProxies []string `json:"trustedProxies"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	for _, p := range req.TrustedProxies {
		if net.ParseIP(p) != nil {
			continue
		}
		if _, _, err := net.ParseCIDR(p); err != nil {
			return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("%q is not an IP address or a network (CIDR)", p)}
		}
	}
	next := loadTLSConfig()
	next.Mode = "proxy"
	next.IssuedFor = nil
	next.TrustedProxies = req.TrustedProxies
	trusting := "this server only"
	if len(req.TrustedProxies) > 0 {
		trusting = strings.Join(req.TrustedProxies, ", ")
	}
	return &opPlan{Op: "tls.proxy", Observed: tlsObserved(), Steps: []planStep{
		tlsConfigStep("Serve HSI over plain HTTP behind a reverse proxy, trusting "+trusting, next),
		tlsRestartStep(),
	}}, nil
}

func planTLSStandardPorts(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	c := loadTLSConfig()
	if !tlsOn(c) {
		return nil, &fsError{Code: "ERR", Message: "Turn HTTPS on first: ports 443 and 80 are only used with HTTPS"}
	}
	if c.StandardPorts == req.Enabled {
		return nil, &fsError{Code: "ENOOP", Message: "Ports 443 and 80 are already set this way"}
	}
	summary := "Stop answering on ports 443 and 80"
	if req.Enabled {
		for _, port := range []int{443, 80} {
			if h := portHolder(port); h != "" {
				return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("Port %d is used by %s: free it first", port, h)}
			}
		}
		summary = "Answer on ports 443 and 80 (80 redirects to HTTPS)"
	}
	next := c
	next.StandardPorts = req.Enabled
	return &opPlan{Op: "tls.standardPorts", Observed: tlsObserved(), Steps: []planStep{
		tlsConfigStep(summary, next),
		tlsRestartStep(),
	}}, nil
}
