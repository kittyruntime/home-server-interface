package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const identityHosts = "127.0.0.1\tlocalhost\n127.0.1.1\tHSI\n\n# IPv6\n::1     localhost ip6-localhost\n"

func stubIdentity(t *testing.T, hosts string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "hosts")
	if err := os.WriteFile(p, []byte(hosts), 0o644); err != nil {
		t.Fatal(err)
	}
	ph, phn, ptz, ptzs := hostsPath, hostHostname, hostTimezone, hostTimezones
	t.Cleanup(func() { hostsPath, hostHostname, hostTimezone, hostTimezones = ph, phn, ptz, ptzs })
	hostsPath = p
	hostHostname = func() string { return "HSI" }
	hostTimezone = func() string { return "Etc/UTC" }
	hostTimezones = func() []string { return []string{"Etc/UTC", "Europe/Paris"} }
	return p
}

func TestIdentityHostname(t *testing.T) {
	stubIdentity(t, identityHosts)
	p, fe := build(t, planSystemIdentity, `{"hostname":"nas","timezone":"Etc/UTC"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if stepTargets(p) != "run:nas update:"+hostsPath || strings.Join(p.Steps[0].Command, " ") != "hostnamectl set-hostname nas" {
		t.Fatalf("steps: %s %v", stepTargets(p), p.Steps[0].Command)
	}
}

func TestIdentityHostsEdit(t *testing.T) {
	path := stubIdentity(t, identityHosts)
	p, _ := build(t, planSystemIdentity, `{"hostname":"nas"}`)
	if !strings.Contains(p.Steps[1].Diff, "-127.0.1.1\tHSI") || !strings.Contains(p.Steps[1].Diff, "+127.0.1.1\tnas") {
		t.Fatalf("diff: %s", p.Steps[1].Diff)
	}
	if _, err := p.Steps[1].run(); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != strings.Replace(identityHosts, "127.0.1.1\tHSI", "127.0.1.1\tnas", 1) {
		t.Fatalf("only the 127.0.1.1 line changes: %q", got)
	}
	// No 127.0.1.1 line: one is added after 127.0.0.1.
	path = stubIdentity(t, "127.0.0.1\tlocalhost\n::1 localhost\n")
	p, _ = build(t, planSystemIdentity, `{"hostname":"nas"}`)
	_, _ = p.Steps[1].run()
	got, _ = os.ReadFile(path)
	if string(got) != "127.0.0.1\tlocalhost\n127.0.1.1\tnas\n::1 localhost\n" {
		t.Fatalf("added: %q", got)
	}
}

func TestIdentityTimezone(t *testing.T) {
	stubIdentity(t, identityHosts)
	p, fe := build(t, planSystemIdentity, `{"hostname":"HSI","timezone":"Europe/Paris"}`)
	if fe != nil || len(p.Steps) != 1 || strings.Join(p.Steps[0].Command, " ") != "timedatectl set-timezone Europe/Paris" {
		t.Fatalf("%+v %+v", p, fe)
	}
}

func TestIdentityRefusals(t *testing.T) {
	stubIdentity(t, identityHosts)
	for _, in := range []string{`{"hostname":"-bad"}`, `{"hostname":"a_b"}`, `{"hostname":"` + strings.Repeat("a", 64) + `"}`, `{"timezone":"Mars/Olympus"}`} {
		if _, fe := build(t, planSystemIdentity, in); fe == nil || fe.Code != "ERR" {
			t.Errorf("%s: %+v", in, fe)
		}
	}
	if _, fe := build(t, planSystemIdentity, `{"hostname":"HSI","timezone":"Etc/UTC"}`); fe == nil || fe.Code != "ENOOP" {
		t.Fatalf("nothing to change: %+v", fe)
	}
}

func TestSystemIdentityStatus(t *testing.T) {
	stubIdentity(t, identityHosts)
	raw, _ := json.Marshal(systemIdentity())
	if string(raw) != `{"hostname":"HSI","timezone":"Etc/UTC","timezones":["Etc/UTC","Europe/Paris"]}` {
		t.Fatal(string(raw))
	}
}

// The domain and other aliases on the 127.0.1.1 line are kept (review M7).
func TestIdentityHostsKeepsDomain(t *testing.T) {
	got := hostsWithName("127.0.0.1\tlocalhost\n127.0.1.1\tHSI.example.lan HSI extra\n", "HSI", "nas")
	if got != "127.0.0.1\tlocalhost\n127.0.1.1\tnas.example.lan nas extra\n" {
		t.Fatalf("%q", got)
	}
	// The line names another host (edited by hand): it is replaced.
	if got := hostsWithName("127.0.1.1\tother\n", "HSI", "nas"); got != "127.0.1.1\tnas\n" {
		t.Fatalf("%q", got)
	}
}
