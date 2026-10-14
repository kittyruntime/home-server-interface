package main

import (
	"errors"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLoadTLSConfigDefaultsToOff(t *testing.T) {
	stubTLS(t)
	c := loadTLSConfig()
	if c.Mode != "off" || c.Port != 9001 {
		t.Fatalf("%+v", c)
	}
}

func TestRenewLocalIfNeeded(t *testing.T) {
	stubTLS(t)
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	if err := saveTLSConfig(tlsConfig{Mode: "local", Port: 9001}); err != nil {
		t.Fatal(err)
	}
	if r, why, err := renewLocalIfNeeded(now); err != nil || !r || why != "missing" {
		t.Fatalf("first issue: %v %q %v", r, why, err)
	}
	if r, _, _ := renewLocalIfNeeded(now.Add(24 * time.Hour)); r {
		t.Fatal("nothing to renew the next day")
	}
	if r, why, _ := renewLocalIfNeeded(now.Add(370 * 24 * time.Hour)); !r || why != "expiring" {
		t.Fatalf("renew under 30 days: %v %q", r, why)
	}
	hostAddrs = func() []net.IP { return []net.IP{net.ParseIP("192.168.1.60")} } // DHCP gave a new address
	if r, why, _ := renewLocalIfNeeded(now.Add(371 * 24 * time.Hour)); !r || why != "names" {
		t.Fatalf("renew on a new IP: %v %q", r, why)
	}
	if got := loadTLSConfig().IssuedFor; !containsString(got, "192.168.1.60") {
		t.Fatalf("issuedFor %v", got)
	}
	if err := saveTLSConfig(tlsConfig{Mode: "imported", Port: 9001}); err != nil {
		t.Fatal(err)
	}
	if r, _, _ := renewLocalIfNeeded(now.Add(400 * 24 * time.Hour)); r {
		t.Fatal("an imported certificate is never replaced")
	}
}

func TestTLSIssueForceFallsBackToLocal(t *testing.T) {
	dir := stubTLS(t)
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	if err := saveTLSConfig(tlsConfig{Mode: "imported", Port: 9001, IssuedFor: []string{"x"}}); err != nil {
		t.Fatal(err)
	}
	if r, _, _ := tlsIssue(now, false); r {
		t.Fatal("without force an imported certificate is kept")
	}
	if loadTLSConfig().Mode != "imported" {
		t.Fatal("mode must stay imported")
	}
	r, why, err := tlsIssue(now, true)
	if err != nil || !r || why != "fallback" {
		t.Fatalf("%v %q %v", r, why, err)
	}
	c := loadTLSConfig()
	if c.Mode != "local" || !containsString(c.IssuedFor, "192.168.1.48") {
		t.Fatalf("%+v", c)
	}
	b, err := os.ReadFile(filepath.Join(dir, "server.crt"))
	if err != nil {
		t.Fatal(err)
	}
	info, err := readCertInfo(b)
	if err != nil || !info.FromAuthority {
		t.Fatalf("%+v %v", info, err)
	}
	// force in local mode behaves like the normal renewal
	if r, _, _ := tlsIssue(now.Add(time.Hour), true); r {
		t.Fatal("nothing to renew")
	}
}

func TestTLSMigrate(t *testing.T) {
	dir := stubTLS(t)
	site := filepath.Join(t.TempDir(), "hsi-site")
	oldSite := nginxSitePath
	t.Cleanup(func() { nginxSitePath = oldSite })
	nginxSitePath = site
	if code := runTLSCLI([]string{"migrate", "--port", "9001"}); code != 0 {
		t.Fatal(code)
	}
	if c := loadTLSConfig(); c.Mode != "off" {
		t.Fatalf("no nginx site: %+v", c)
	}
	_ = os.Remove(filepath.Join(dir, "tls.json"))
	_ = os.WriteFile(site, []byte("server {}"), 0o644)
	runTLSCLI([]string{"migrate", "--port", "9001"})
	if c := loadTLSConfig(); c.Mode != "proxy" {
		t.Fatalf("nginx site: %+v", c)
	}
	_ = saveTLSConfig(tlsConfig{Mode: "local", Port: 9001})
	runTLSCLI([]string{"migrate", "--port", "9001"})
	if c := loadTLSConfig(); c.Mode != "local" {
		t.Fatal("migrate never changes an existing config")
	}
}

func TestSetupLinkScheme(t *testing.T) {
	if got := setupLink("https", "10.0.0.2", 9001, "tok"); got != "https://10.0.0.2:9001/setup#token=tok" {
		t.Fatal(got)
	}
	if got := setupLink("http", "10.0.0.2", 80, "tok"); got != "http://10.0.0.2/setup#token=tok" {
		t.Fatal(got)
	}
	if got := setupLink("https", "10.0.0.2", 443, "tok"); got != "https://10.0.0.2/setup#token=tok" {
		t.Fatal(got)
	}
}

func currentGroupName(t *testing.T) string {
	t.Helper()
	g, err := user.LookupGroupId(strconv.Itoa(os.Getgid()))
	if err != nil {
		t.Skip("no name for the current group")
	}
	return g.Name
}

func TestTLSInitGroupIsStoredAndUsed(t *testing.T) {
	dir := stubTLS(t)
	tlsAppGroup = defaultTLSAppGroup // the real lookup, driven by tls.json
	t.Setenv("HSI_APP_GROUP", "no-such-group-hsi-test")
	group := currentGroupName(t)
	if code := runTLSCLI([]string{"init", "--port", "9001", "--group", group}); code != 0 {
		t.Fatal(code)
	}
	c := loadTLSConfig()
	if c.Mode != "local" || c.Group != group {
		t.Fatalf("%+v", c)
	}
	st, err := os.Stat(filepath.Join(dir, "server.key"))
	if err != nil {
		t.Fatal(err)
	}
	if gid := st.Sys().(*syscall.Stat_t).Gid; int(gid) != os.Getgid() {
		t.Fatalf("server.key group %d", gid)
	}
}

func TestTLSInitFailureLeavesNoLocalConfig(t *testing.T) {
	dir := stubTLS(t)
	tlsAppGroup = func() (int, error) { return 0, errors.New("unknown group") }
	if code := runTLSCLI([]string{"init", "--port", "9001", "--group", "nope"}); code == 0 {
		t.Fatal("init must fail when the certificate cannot be issued")
	}
	if c := loadTLSConfig(); c.Mode == "local" {
		t.Fatalf("local mode without a certificate: %+v", c)
	}
	if _, err := os.Stat(filepath.Join(dir, "server.crt")); err == nil {
		t.Fatal("no certificate expected")
	}
}

func TestTLSMigrateUpdatesPortAndGroup(t *testing.T) {
	stubTLS(t)
	if err := saveTLSConfig(tlsConfig{Mode: "local", Port: 9001, StandardPorts: true,
		TrustedProxies: []string{"10.0.0.1"}, IssuedFor: []string{"nas"}}); err != nil {
		t.Fatal(err)
	}
	if code := runTLSCLI([]string{"migrate", "--port", "9100", "--group", "staff"}); code != 0 {
		t.Fatal(code)
	}
	c := loadTLSConfig()
	if c.Mode != "local" || c.Port != 9100 || c.Group != "staff" || !c.StandardPorts ||
		strings.Join(c.TrustedProxies, ",") != "10.0.0.1" || strings.Join(c.IssuedFor, ",") != "nas" {
		t.Fatalf("only the port and group change: %+v", c)
	}
	// Without --port, the stored port is kept.
	if code := runTLSCLI([]string{"migrate"}); code != 0 || loadTLSConfig().Port != 9100 {
		t.Fatal("port kept")
	}
}

func TestTLSInitUpdatesPortOnExistingConfig(t *testing.T) {
	stubTLS(t)
	if err := saveTLSConfig(tlsConfig{Mode: "off", Port: 9001}); err != nil {
		t.Fatal(err)
	}
	if code := runTLSCLI([]string{"init", "--port", "9200"}); code != 0 {
		t.Fatal(code)
	}
	if c := loadTLSConfig(); c.Mode != "off" || c.Port != 9200 {
		t.Fatalf("%+v", c)
	}
}

func TestTLSIssueForceRepairsLocalKey(t *testing.T) {
	dir := stubTLS(t)
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	if err := saveTLSConfig(tlsConfig{Mode: "local", Port: 9001}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := tlsIssue(now, false); err != nil {
		t.Fatal(err)
	}
	_, otherKey := selfSigned(t, now.Add(90*24*time.Hour))
	if err := os.WriteFile(filepath.Join(dir, "server.key"), otherKey, 0o640); err != nil {
		t.Fatal(err)
	}
	r, why, err := tlsIssue(now.Add(time.Hour), true)
	if err != nil || !r || why != "fallback" {
		t.Fatalf("%v %q %v", r, why, err)
	}
	crt, _ := os.ReadFile(filepath.Join(dir, "server.crt"))
	key, _ := os.ReadFile(filepath.Join(dir, "server.key"))
	if _, err := tlsKeyPair(crt, key); err != nil {
		t.Fatalf("the pair must load: %v", err)
	}
}

func TestRenewLocalTreatsUnloadablePairAsMissing(t *testing.T) {
	dir := stubTLS(t)
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	if err := saveTLSConfig(tlsConfig{Mode: "local", Port: 9001}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := renewLocalIfNeeded(now); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir, "server.key"))
	if r, why, err := renewLocalIfNeeded(now.Add(time.Hour)); err != nil || !r || why != "missing" {
		t.Fatalf("%v %q %v", r, why, err)
	}
}
