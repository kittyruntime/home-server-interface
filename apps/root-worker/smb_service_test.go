package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSmbStatusCarriesPidAndIP(t *testing.T) {
	b, err := os.ReadFile("testdata/smbstatus.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseSmbStatus(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %+v, want one connection", got)
	}
	c := got[0]
	if c.User != "fxa" || c.Share != "Films" || c.Pid != "647949" || c.IP != "192.168.1.48" || c.SessionID != "3344555492" || c.ConnectedAt == "" {
		t.Fatalf("got %+v", c)
	}
}

func stubSmbRun(t *testing.T) *[][]string {
	t.Helper()
	var ran [][]string
	prevRun, prevStatus := smbRun, smbStatusJSON
	smbRun = func(name string, args ...string) error {
		ran = append(ran, append([]string{name}, args...))
		return nil
	}
	smbStatusJSON = func() ([]byte, error) { return os.ReadFile("testdata/smbstatus.json") }
	t.Cleanup(func() { smbRun, smbStatusJSON = prevRun, prevStatus })
	return &ran
}

func TestDisconnectRefusesAPidThatIsNotASession(t *testing.T) {
	ran := stubSmbRun(t)
	for _, pid := range []string{"1", "12345", "647949; rm", ""} {
		if fe := disconnectSmbSession(pid); fe == nil || fe.Code != "NOT_A_SESSION" {
			t.Errorf("pid %q: got %v, want NOT_A_SESSION", pid, fe)
		}
	}
	if len(*ran) != 0 {
		t.Fatalf("ran %v for refused pids", *ran)
	}
	if fe := disconnectSmbSession("647949"); fe != nil {
		t.Fatal(fe)
	}
	if len(*ran) != 1 || strings.Join((*ran)[0], " ") != "smbcontrol 647949 shutdown" {
		t.Fatalf("ran %v", *ran)
	}
}

func TestAvahiServiceFile(t *testing.T) {
	f := avahiServiceFile("", nil)
	for _, s := range []string{"<type>_smb._tcp</type>", "<port>445</port>", `<name replace-wildcards="yes">%h</name>`} {
		if !strings.Contains(f, s) {
			t.Errorf("missing %q in\n%s", s, f)
		}
	}
	if f := avahiServiceFile("A<B&C", nil); !strings.Contains(f, "A&lt;B&amp;C") {
		t.Fatalf("name not escaped:\n%s", f)
	}
}

func TestAvahiAnnouncesTimeMachine(t *testing.T) {
	f := avahiServiceFile("", []string{"Backups", "Mac&Co"})
	for _, s := range []string{"<type>_adisk._tcp</type>", "<txt-record>sys=waMa=0,adVF=0x100</txt-record>",
		"<txt-record>dk0=adVN=Backups,adVF=0x82</txt-record>", "<txt-record>dk1=adVN=Mac&amp;Co,adVF=0x82</txt-record>"} {
		if !strings.Contains(f, s) {
			t.Errorf("missing %q in\n%s", s, f)
		}
	}
	if strings.Contains(avahiServiceFile("", nil), "_adisk") {
		t.Fatal("Time Machine announced without a Time Machine share")
	}
}

func TestSmbModuleAvailable(t *testing.T) {
	has := func(p string) bool { return p == "/usr/lib/samba/vfs/fruit.so" }
	if !smbModuleAvailable("MODULESDIR: /usr/lib/samba", "fruit", has) {
		t.Fatal("module file not found")
	}
	if smbModuleAvailable("MODULESDIR: /usr/lib/samba", "streams_xattr", has) {
		t.Fatal("missing module reported")
	}
	if !smbModuleAvailable("vfs_streams_xattr_init", "streams_xattr", has) {
		t.Fatal("built-in module not seen")
	}
}

func TestDiscoveryRemovesOnlyItsOwnFile(t *testing.T) {
	dir := t.TempDir()
	prevDir, prevLook := avahiServicesDir, hostLookPath
	avahiServicesDir = dir
	hostLookPath = func(n string) bool { return n == "avahi-daemon" }
	t.Cleanup(func() { avahiServicesDir, hostLookPath = prevDir, prevLook })
	stubSmbRun(t)
	other := filepath.Join(dir, "ssh.service")
	_ = os.WriteFile(other, []byte("x"), 0o644)
	if fe := applySmbDiscovery(nil, ptr(true), "NAS", nil); fe != nil {
		t.Fatal(fe)
	}
	if _, err := os.Stat(filepath.Join(dir, "hsi-smb.service")); err != nil {
		t.Fatal("service file not written")
	}
	if fe := applySmbDiscovery(nil, ptr(false), "", nil); fe != nil {
		t.Fatal(fe)
	}
	if _, err := os.Stat(filepath.Join(dir, "hsi-smb.service")); !os.IsNotExist(err) {
		t.Fatal("service file kept")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("another service file was removed")
	}
	if fe := applySmbDiscovery(ptr(true), nil, "", nil); fe == nil || fe.Code != "TOOL_MISSING" {
		t.Fatalf("wsd without wsdd: %v", fe)
	}
}

func TestServiceActionRejectsUnknownAction(t *testing.T) {
	ran := stubSmbRun(t)
	if fe := smbServiceAction("stop; reboot"); fe == nil {
		t.Fatal("unknown action accepted")
	}
	if fe := smbServiceAction("restart"); fe != nil || len(*ran) != 1 || strings.Join((*ran)[0], " ") != "systemctl restart smbd" {
		t.Fatalf("restart: %v %v", fe, *ran)
	}
}

func TestSmbAuditSupported(t *testing.T) {
	if !smbAuditSupported("   HAVE_JANSSON\n   vfs_full_audit_init\n", false) {
		t.Fatal("built-in full_audit with jansson not detected")
	}
	if !smbAuditSupported("   HAVE_JANSSON\n", true) {
		t.Fatal("full_audit module with jansson not detected")
	}
	if smbAuditSupported("   vfs_full_audit_init\n", true) {
		t.Fatal("audit without jansson accepted")
	}
}

func ptr(b bool) *bool { return &b }

func TestDiscoveryLeavesWsddAloneWhenNotAsked(t *testing.T) {
	ran := stubSmbRun(t)
	prevDir, prevLook := avahiServicesDir, hostLookPath
	avahiServicesDir = t.TempDir()
	hostLookPath = func(n string) bool { return n == "wsdd" || n == "avahi-daemon" }
	t.Cleanup(func() { avahiServicesDir, hostLookPath = prevDir, prevLook })
	// A rename or the macOS switch must not touch a wsdd the admin runs.
	if fe := applySmbDiscovery(nil, ptr(true), "NAS", nil); fe != nil {
		t.Fatal(fe)
	}
	if len(*ran) != 0 {
		t.Fatalf("ran %v without a Windows discovery change", *ran)
	}
	if fe := applySmbDiscovery(ptr(false), nil, "", nil); fe != nil {
		t.Fatal(fe)
	}
	if len(*ran) != 1 || strings.Join((*ran)[0], " ") != "systemctl disable --now wsdd" {
		t.Fatalf("ran %v", *ran)
	}
	if _, err := os.Stat(filepath.Join(avahiServicesDir, "hsi-smb.service")); err != nil {
		t.Fatal("a Windows-only change removed the macOS announcement")
	}
}
