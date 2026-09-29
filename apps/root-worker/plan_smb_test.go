package main

import (
	"reflect"
	"strings"
	"testing"
)

func stubSmbHost(t *testing.T, conf string, confExists, dropIn bool) *map[string]string {
	t.Helper()
	pi, pr, pe, pw := hostSmbdInstalled, hostReadFile, hostExists, hostWriteFile
	t.Cleanup(func() { hostSmbdInstalled, hostReadFile, hostExists, hostWriteFile = pi, pr, pe, pw })
	written := map[string]string{}
	hostSmbdInstalled = func() bool { return true }
	hostReadFile = func(p string) ([]byte, error) {
		if p == smbConfPath && confExists {
			return []byte(conf), nil
		}
		return nil, errNotExist
	}
	hostExists = func(p string) bool { return p == dropInPath && dropIn }
	hostWriteFile = func(p, content string) error { written[p] = content; return nil }
	return &written
}

const oneShare = `{"shares":[{"name":"media","path":"/srv/media","validUsers":["alice"],"writeUsers":["alice"]}]}`

func TestPlanSmbSyncUpdate(t *testing.T) {
	written := stubSmbHost(t, "# old\n", true, true)
	p, fe := build(t, planSmbSync, oneShare)
	if fe != nil {
		t.Fatal(fe)
	}
	if p.Steps[0].Kind != "update" || p.Steps[0].Target != smbConfPath || !strings.Contains(p.Steps[0].Diff, "+[media]") {
		t.Fatalf("smb.conf step: %+v", p.Steps[0])
	}
	want := [][]string{{"systemctl", "enable", "--quiet", "smbd"}, {"systemctl", "reload-or-restart", "smbd"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	if p.Steps[1].OnFailure != "warn" {
		t.Fatal("enable must only warn")
	}
	assertParity(t, p)
	if !strings.Contains((*written)[smbConfPath], "[media]") {
		t.Fatal("apply must write the previewed smb.conf")
	}
}

func TestPlanSmbSyncFirstInstall(t *testing.T) {
	written := stubSmbHost(t, "", false, false)
	p, fe := build(t, planSmbSync, oneShare)
	if fe != nil {
		t.Fatal(fe)
	}
	if p.Steps[0].Kind != "create" || p.Steps[0].Target != dropInPath || p.Steps[1].Kind != "create" || p.Steps[1].Target != smbConfPath {
		t.Fatalf("first install steps: %+v", p.Steps[:2])
	}
	want := [][]string{{"systemctl", "daemon-reload"}, {"systemctl", "enable", "--quiet", "smbd"}, {"systemctl", "restart", "smbd"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	assertParity(t, p)
	if (*written)[dropInPath] != dropInContent {
		t.Fatal("apply must write the drop-in")
	}
}

func TestPlanSmbSyncStale(t *testing.T) {
	stubSmbHost(t, "# old\n", true, true)
	in := []byte(oneShare)
	p1, _ := planSmbSync(in)
	stubSmbHost(t, "# edited by a resync\n", true, true)
	p2, _ := planSmbSync(in)
	if p1.fingerprint(in) == p2.fingerprint(in) {
		t.Fatal("a changed smb.conf must make the plan stale")
	}
	stubSmbHost(t, "# old\n", true, false)
	p3, _ := planSmbSync(in)
	if p1.fingerprint(in) == p3.fingerprint(in) {
		t.Fatal("a removed drop-in must make the plan stale")
	}
}

func TestPlanSmbSyncRefusals(t *testing.T) {
	stubSmbHost(t, "", true, true)
	_, fe := build(t, planSmbSync, `{"shares":[{"name":"bad name","path":"/srv/x"}]}`)
	wantErr(t, fe, "ERR")
	hostSmbdInstalled = func() bool { return false }
	_, fe = build(t, planSmbSync, oneShare)
	wantErr(t, fe, "SMBD_MISSING")
}
