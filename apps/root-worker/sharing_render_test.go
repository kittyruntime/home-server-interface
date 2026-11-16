package main

import (
	"strings"
	"testing"
)

var renderShares = []shareDef{{
	Name: "Films", Path: "/srv/media/Films",
	ValidUsers: []string{"alice", "bob"}, WriteUsers: []string{"alice"},
}}

const todaysConf = `# Managed by nasui root-worker. Do not edit; regenerated on every sync.
[global]
   server role = standalone server
   server min protocol = SMB2
   map to guest = Bad User
   load printers = no
   printing = bsd
   disable spoolss = yes

[Films]
   path = /srv/media/Films
   browseable = yes
   veto files = /.hsi-trash/
   read only = yes
   valid users = alice bob
   write list = alice
   force group = hsi-share
   create mask = 0664
   directory mask = 0775
`

func mustRender(t *testing.T, shares []shareDef, s smbSettings) string {
	t.Helper()
	conf, err := renderSmbConf(shares, s)
	if err != nil {
		t.Fatal(err)
	}
	return conf
}

func wantLines(t *testing.T, conf string, lines ...string) {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(conf, "   "+l+"\n") {
			t.Errorf("missing %q in:\n%s", l, conf)
		}
	}
}

func TestRenderSmbConfDefaultsKeepTodaysGlobals(t *testing.T) {
	if got := mustRender(t, renderShares, smbSettings{}); got != todaysConf {
		t.Fatalf("default render changed:\n%s", got)
	}
}

func TestRenderSmbConfSettings(t *testing.T) {
	conf := mustRender(t, renderShares, smbSettings{NetbiosName: "HSI", Workgroup: "HOME", MinProtocol: "SMB3", Encryption: "required"})
	wantLines(t, conf, "netbios name = HSI", "workgroup = HOME", "server min protocol = SMB3", "server smb encrypt = required")
	if strings.Contains(conf, "server min protocol = SMB2") {
		t.Fatal("SMB2 floor still written")
	}
}

func TestRenderSmbConfAuditLines(t *testing.T) {
	conf := mustRender(t, renderShares, smbSettings{Audit: true})
	wantLines(t, conf,
		"logging = file", "log file = /var/log/hsi/samba/smbd.log", "log level = 1 auth_json_audit:3",
		"vfs objects = full_audit", "full_audit:prefix = %u|%I|%m|%S",
		"full_audit:success = connect disconnect", "full_audit:failure = connect", "full_audit:syslog = false")
}

func TestRenderOmitsAuditWhenUnsupported(t *testing.T) {
	conf := mustRender(t, renderShares, smbSettings{Audit: false})
	for _, s := range []string{"full_audit", "auth_json_audit", "log file"} {
		if strings.Contains(conf, s) {
			t.Fatalf("%q written without audit support", s)
		}
	}
}

func TestRenderHiddenShare(t *testing.T) {
	shares := []shareDef{renderShares[0]}
	shares[0].Hidden = true
	conf := mustRender(t, shares, smbSettings{})
	wantLines(t, conf, "browseable = no")
	if strings.Contains(conf, "browseable = yes") {
		t.Fatal("hidden share still browseable")
	}
}

func TestRenderHostsDenyValidatesIPs(t *testing.T) {
	conf := mustRender(t, renderShares, smbSettings{HostsDeny: []string{"192.168.1.9", "127.0.0.1", "::1", "fe80::2"}})
	wantLines(t, conf, "hosts deny = 192.168.1.9 fe80::2")
	// A bad entry is dropped, never written and never blocks the whole sync.
	conf = mustRender(t, renderShares, smbSettings{HostsDeny: []string{"1.2.3.4 ALL", "x\n[evil]", "10.0.0.0/8", "fe80::1%eth0", "192.168.1.9"}})
	wantLines(t, conf, "hosts deny = 192.168.1.9")
	for _, bad := range []string{"ALL", "[evil]", "10.0.0.0", "%eth0"} {
		if strings.Contains(conf, bad) {
			t.Errorf("%q written:\n%s", bad, conf)
		}
	}
	if strings.Contains(mustRender(t, renderShares, smbSettings{HostsDeny: []string{"127.0.0.1"}}), "hosts deny") {
		t.Fatal("loopback alone must not write hosts deny")
	}
}

func TestRenderRejectsUnknownSettingValues(t *testing.T) {
	for _, s := range []smbSettings{
		{MinProtocol: "NT1"}, {Encryption: "maybe"},
		{NetbiosName: "SIXTEEN-CHARS-AB"}, {NetbiosName: "has space"}, {Workgroup: "a\nb"},
	} {
		if _, err := renderSmbConf(renderShares, s); err == nil {
			t.Errorf("settings %+v accepted", s)
		}
	}
}
