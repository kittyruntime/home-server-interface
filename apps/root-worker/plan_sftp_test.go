package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

type sftpHost struct {
	written  map[string]string
	prepared []string
	tidied   []string
	checked  int
}

// stubSftpHost: Samba absent (so only SFTP plans), sshd with Debian's config,
// the passwd fixture, the given mountinfo and drop-in, and a group roster.
func stubSftpHost(t *testing.T, mountinfo, dropIn, groupLine string, sshdOK bool) *sftpHost {
	t.Helper()
	h := &sftpHost{}
	written := stubSmbHost(t, "", true, true)
	h.written = *written
	hostSmbdInstalled = func() bool { return false }
	pr, pl, pe, prm, pc, pp, pt := hostReadFile, hostLookPath, hostExists, hostRemoveFile, hostSshdCheck, hostPrepareSftpDirs, hostTidySftp
	t.Cleanup(func() {
		hostReadFile, hostLookPath, hostExists, hostRemoveFile, hostSshdCheck, hostPrepareSftpDirs, hostTidySftp = pr, pl, pe, prm, pc, pp, pt
	})
	files := map[string]string{
		sshdConfigPath:         "Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n",
		"/etc/passwd":          passwdFixture,
		"/proc/self/mountinfo": mountinfo,
		"/etc/group":           groupLine,
	}
	if dropIn != "" {
		files[sftpDropInPath] = dropIn
	}
	hostReadFile = func(p string) ([]byte, error) {
		if c, ok := files[p]; ok {
			return []byte(c), nil
		}
		return nil, errNotExist
	}
	hostLookPath = func(n string) bool { return n == "sshd" }
	hostExists = func(p string) bool { return p == "/usr/lib/systemd/system/ssh.service" || files[p] != "" }
	hostRemoveFile = func(p string) error { h.written[p] = "<removed>"; return nil }
	hostSshdCheck = func() ([]byte, error) {
		h.checked++
		if !sshdOK {
			return []byte("line 4: Bad configuration option"), errors.New("exit status 255")
		}
		return nil, nil
	}
	hostPrepareSftpDirs = func(dirs []string) error { h.prepared = append(h.prepared, dirs...); return nil }
	hostTidySftp = func(dirs []string) error { h.tidied = append(h.tidied, dirs...); return nil }
	return h
}

const srvMountinfo = "22 1 253:0 / / rw,relatime shared:1 - ext4 /dev/vg-root rw\n40 22 8:17 / /srv rw,relatime shared:20 - ext4 /dev/sdb1 rw\n"

func sftpInput(users string) string {
	return `{"shares":[],"nfs":{"exports":[]},"sftp":{"users":` + users + `}}`
}

func TestPlanSftpFirstShare(t *testing.T) {
	h := stubSftpHost(t, srvMountinfo, "", "", true)
	p, fe := build(t, planSmbSync, sftpInput(`[{"user":"alice","shares":[{"name":"Films","path":"/srv/films","write":true}]}]`))
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{
		{"groupadd", "-f", "hsi-sftp"},
		{"gpasswd", "-M", "alice", "hsi-sftp"},
		{"mount", "--bind", "/srv/films", "/var/lib/hsi-sftp/alice/Films"},
		{"systemctl", "try-reload-or-restart", "ssh"},
	}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	assertParity(t, p)
	if h.written[sftpDropInPath] != sftpDropIn || h.checked != 1 {
		t.Fatalf("drop-in %q, sshd -t run %d times", h.written[sftpDropInPath], h.checked)
	}
	if !reflect.DeepEqual(h.prepared, []string{"/var/lib/hsi-sftp/alice", "/var/lib/hsi-sftp/alice/Films"}) {
		t.Fatalf("prepared %v", h.prepared)
	}
}

func TestPlanSftpReadOnlyView(t *testing.T) {
	stubSftpHost(t, srvMountinfo, sftpDropIn, "hsi-sftp:x:990:alice\n", true)
	p, fe := build(t, planSmbSync, sftpInput(`[{"user":"alice","shares":[{"name":"Films","path":"/srv/films","write":false}]}]`))
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{
		{"mount", "--bind", "/srv/films", "/var/lib/hsi-sftp/alice/Films"},
		{"mount", "-o", "remount,bind,ro", "/var/lib/hsi-sftp/alice/Films"},
	}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
}

func TestPlanSftpLeavesShellAccountsAlone(t *testing.T) {
	h := stubSftpHost(t, srvMountinfo, "", "", true)
	p, fe := build(t, planSmbSync, sftpInput(`[{"user":"theophile","shares":[{"name":"Films","path":"/srv/films","write":true}]}]`))
	if fe != nil {
		t.Fatal(fe)
	}
	for _, a := range argvs(p) {
		if strings.Contains(strings.Join(a, " "), "theophile") {
			t.Fatalf("an account with a shell is touched: %v", a)
		}
	}
	if _, ok := h.written[sftpDropInPath]; ok {
		t.Fatal("sshd configured with nobody to serve")
	}
}

func TestPlanSftpRefusals(t *testing.T) {
	in := sftpInput(`[{"user":"alice","shares":[{"name":"Films","path":"/srv/films","write":true}]}]`)
	stubSftpHost(t, srvMountinfo, "", "", true)
	hostLookPath = func(string) bool { return false }
	_, fe := build(t, planSmbSync, in)
	wantErr(t, fe, "SFTP_MISSING")

	stubSftpHost(t, srvMountinfo, "", "", true)
	read := hostReadFile
	hostReadFile = func(p string) ([]byte, error) {
		if p == sshdConfigPath {
			return []byte("Port 22\n"), nil
		}
		return read(p)
	}
	_, fe = build(t, planSmbSync, in)
	wantErr(t, fe, "SFTP_UNSUPPORTED")

	stubSftpHost(t, srvMountinfo, "", "", true)
	_, fe = build(t, planSmbSync, sftpInput(`[{"user":"alice","shares":[{"name":"../x","path":"/srv/films","write":true}]}]`))
	wantErr(t, fe, "ERR")
	_, fe = build(t, planSmbSync, sftpInput(`[{"user":"alice","shares":[{"name":"Films","path":"/srv/a\"b","write":true}]}]`))
	wantErr(t, fe, "ERR")
}

func TestPlanSftpBadConfigIsTakenBack(t *testing.T) {
	h := stubSftpHost(t, srvMountinfo, "", "", false)
	p, fe := build(t, planSmbSync, sftpInput(`[{"user":"alice","shares":[{"name":"Films","path":"/srv/films","write":true}]}]`))
	if fe != nil {
		t.Fatal(fe)
	}
	runArgv = func(argv []string) ([]byte, error) { return nil, nil }
	if _, ok, _ := p.execute(); ok {
		t.Fatal("a configuration sshd refuses must fail the plan")
	}
	if h.written[sftpDropInPath] != "<removed>" {
		t.Fatalf("the refused drop-in stayed: %q", h.written[sftpDropInPath])
	}
}

func TestPlanSftpRevokesAndEndsSessions(t *testing.T) {
	mi := srvMountinfo + "50 22 8:17 /films /var/lib/hsi-sftp/alice/Films rw,relatime shared:20 - ext4 /dev/sdb1 rw\n" +
		"51 22 8:17 /music /var/lib/hsi-sftp/alice/Music rw,relatime shared:20 - ext4 /dev/sdb1 rw\n"
	h := stubSftpHost(t, mi, sftpDropIn, "hsi-sftp:x:990:alice\n", true)
	p, fe := build(t, planSmbSync, sftpInput(`[{"user":"alice","shares":[{"name":"Films","path":"/srv/films","write":true}]}]`))
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{
		{"umount", "-l", "/var/lib/hsi-sftp/alice/Music"},
		{"pkill", "-u", "alice", "-f", "@internal-sftp"},
	}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	assertParity(t, p)
	if !reflect.DeepEqual(h.tidied, []string{"/var/lib/hsi-sftp/alice/Music"}) {
		t.Fatalf("tidied %v", h.tidied)
	}
}

func TestPlanSftpTurnedOff(t *testing.T) {
	mi := srvMountinfo + "50 22 8:17 /films /var/lib/hsi-sftp/alice/Films rw,relatime shared:20 - ext4 /dev/sdb1 rw\n"
	h := stubSftpHost(t, mi, sftpDropIn, "hsi-sftp:x:990:alice\n", true)
	p, fe := build(t, planSmbSync, sftpInput(`[]`))
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{
		{"gpasswd", "-M", "", "hsi-sftp"},
		{"umount", "-l", "/var/lib/hsi-sftp/alice/Films"},
		{"pkill", "-u", "alice", "-f", "@internal-sftp"},
		{"systemctl", "try-reload-or-restart", "ssh"},
	}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	assertParity(t, p)
	if h.written[sftpDropInPath] != "<removed>" {
		t.Fatal("drop-in kept")
	}
	if !reflect.DeepEqual(h.tidied, []string{"/var/lib/hsi-sftp/alice/Films", "/var/lib/hsi-sftp/alice"}) {
		t.Fatalf("tidied %v", h.tidied)
	}
}

func TestPlanSftpNothingAskedNothingDone(t *testing.T) {
	stubSftpHost(t, srvMountinfo, "", "", true)
	p, fe := build(t, planSmbSync, sftpInput(`[]`))
	if fe != nil || len(p.Steps) != 0 {
		t.Fatalf("steps %+v, %v", p.Steps, fe)
	}
}
