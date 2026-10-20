package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func planFor(t *testing.T, op string, in any) *opPlan {
	t.Helper()
	raw, _ := json.Marshal(in)
	p, ferr := buildPlan(op, raw)
	if ferr != nil {
		t.Fatalf("%s: %s", op, ferr.Message)
	}
	return p
}

func TestTLSEnablePlan(t *testing.T) {
	stubTLS(t)
	_ = saveTLSConfig(tlsConfig{Mode: "off", Port: 9001})
	var ran [][]string
	old := runArgv
	runArgv = func(argv []string) ([]byte, error) { ran = append(ran, argv); return nil, nil }
	t.Cleanup(func() { runArgv = old })

	p := planFor(t, "tls.enable", map[string]any{})
	last := p.Steps[len(p.Steps)-1]
	if last.Command[0] != "systemd-run" || !strings.HasPrefix(last.Command[1], "--on-active=") {
		t.Fatalf("the restart is delayed so the reply gets out first: %v", last.Command)
	}
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("plan failed")
	}
	if c := loadTLSConfig(); c.Mode != "local" || len(c.IssuedFor) == 0 {
		t.Fatalf("%+v", c)
	}
	if len(ran) != 1 {
		t.Fatalf("one restart: %v", ran)
	}
	if _, ferr := buildPlan("tls.enable", []byte("{}")); ferr == nil || ferr.Code != "ENOOP" {
		t.Fatal("already local")
	}
}

func TestTLSImportPlan(t *testing.T) {
	stubTLS(t)
	_ = saveTLSConfig(tlsConfig{Mode: "local", Port: 9001})
	cert, key := selfSigned(t, time.Now().Add(60*24*time.Hour))
	p := planFor(t, "tls.import", map[string]string{"cert": string(cert), "key": string(key)})
	for _, s := range p.Steps {
		if s.Command != nil {
			t.Fatal("local -> imported is a hot reload, no restart")
		}
		if strings.Contains(s.Diff, "PRIVATE KEY") || strings.Contains(s.Summary, "PRIVATE KEY") {
			t.Fatal("the key never shows in a diff")
		}
	}
	if strings.Contains(string(p.FingerprintInput), "PRIVATE") {
		t.Fatal("the key is not in the fingerprint input")
	}
	if w, _ := p.Reply["warnings"].([]string); len(w) != 1 || !strings.Contains(w[0], "nas") {
		t.Fatalf("nas.example.com does not cover nas: %v", p.Reply)
	}
	warned := false
	for _, s := range p.Steps {
		if s.Target == filepath.Join(tlsDir(), "server.crt") && strings.Contains(s.Summary, "Warning:") {
			warned = true
		}
	}
	if !warned {
		t.Fatal("the preview shows the warning in the certificate step")
	}
	if _, ok, _ := p.execute(); !ok || loadTLSConfig().Mode != "imported" {
		t.Fatal("imported")
	}
	raw, _ := json.Marshal(map[string]string{"cert": string(cert), "key": ""})
	if _, ferr := buildPlan("tls.import", raw); ferr == nil || !strings.Contains(ferr.Message, "private key") {
		t.Fatalf("no key: %v", ferr)
	}
}

func TestTLSProxyAndStandardPortsPlans(t *testing.T) {
	stubTLS(t)
	_ = saveTLSConfig(tlsConfig{Mode: "local", Port: 9001})
	if _, ferr := buildPlan("tls.proxy", []byte(`{"trustedProxies":["not-an-ip"]}`)); ferr == nil {
		t.Fatal("bad proxy address")
	}
	planFor(t, "tls.proxy", map[string]any{"trustedProxies": []string{"172.17.0.0/16", "10.0.0.5"}})
	oldHolder := portHolder
	portHolder = func(port int) string {
		if port == 443 {
			return "the container traefik"
		}
		return ""
	}
	t.Cleanup(func() { portHolder = oldHolder })
	if _, ferr := buildPlan("tls.standardPorts", []byte(`{"enabled":true}`)); ferr == nil || !strings.Contains(ferr.Message, "traefik") {
		t.Fatalf("443 in use: %v", ferr)
	}
	_ = saveTLSConfig(tlsConfig{Mode: "off", Port: 9001})
	if _, ferr := buildPlan("tls.standardPorts", []byte(`{"enabled":true}`)); ferr == nil {
		t.Fatal("443/80 need HTTPS on")
	}
}

func TestSSProcessName(t *testing.T) {
	cases := map[string]string{
		`LISTEN 0 4096 *:443 *:* users:(("docker-proxy",pid=812,fd=4))`:                       "docker-proxy",
		`LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6),("nginx",pid=2,fd=6))`: "nginx",
		`LISTEN 0 511 0.0.0.0:80 0.0.0.0:*`:                                                   "",
		``:                                                                                    "",
	}
	for in, want := range cases {
		if got := ssProcessName(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestCertCoversHost(t *testing.T) {
	if !certCovers([]string{"*.example.com"}, "nas.example.com") || certCovers([]string{"*.example.com"}, "a.b.example.com") || certCovers([]string{"x.com"}, "nas") {
		t.Fatal("wildcard matching")
	}
}

func TestTLSPlansClearStandardPorts(t *testing.T) {
	stubTLS(t)
	old := runArgv
	runArgv = func(argv []string) ([]byte, error) { return nil, nil }
	t.Cleanup(func() { runArgv = old })

	_ = saveTLSConfig(tlsConfig{Mode: "local", Port: 9001, StandardPorts: true})
	p := planFor(t, "tls.proxy", map[string]any{"trustedProxies": []string{"10.0.0.5"}})
	if _, ok, _ := p.execute(); !ok || loadTLSConfig().StandardPorts {
		t.Fatalf("proxy keeps 443/80: %+v", loadTLSConfig())
	}
	_ = saveTLSConfig(tlsConfig{Mode: "off", Port: 9001, StandardPorts: true})
	p = planFor(t, "tls.enable", map[string]any{})
	if _, ok, _ := p.execute(); !ok || loadTLSConfig().StandardPorts {
		t.Fatalf("enable keeps 443/80: %+v", loadTLSConfig())
	}
}

func TestTLSPlansHaveStableFingerprints(t *testing.T) {
	stubTLS(t)
	oldHolder := portHolder
	portHolder = func(int) string { return "" }
	t.Cleanup(func() { portHolder = oldHolder })

	cases := []struct {
		op   string
		mode string
		in   string
	}{
		{"tls.enable", "off", `{}`},
		{"tls.proxy", "local", `{"trustedProxies":["10.0.0.5"]}`},
		{"tls.standardPorts", "local", `{"enabled":true}`},
	}
	for _, c := range cases {
		_ = saveTLSConfig(tlsConfig{Mode: c.mode, Port: 9001})
		raw := []byte(c.in)
		p1, ferr := buildPlan(c.op, raw)
		if ferr != nil {
			t.Fatalf("%s: %s", c.op, ferr.Message)
		}
		time.Sleep(2 * time.Millisecond)
		p2, ferr := buildPlan(c.op, raw)
		if ferr != nil {
			t.Fatalf("%s: %s", c.op, ferr.Message)
		}
		if p1.fingerprint(raw) != p2.fingerprint(raw) {
			t.Fatalf("%s: the fingerprint changes between two previews, so apply always refuses", c.op)
		}
		last := p1.Steps[len(p1.Steps)-1]
		if strings.Join(last.Command, " ") != "systemd-run --on-active=2 --timer-property=AccuracySec=100ms --collect --unit=hsi-server-restart systemctl restart hsi-server.service" {
			t.Fatalf("%s: restart command %v", c.op, last.Command)
		}
	}
}
