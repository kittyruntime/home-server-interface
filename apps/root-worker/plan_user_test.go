package main

import (
	"reflect"
	"strings"
	"testing"
)

func stubUserHost(t *testing.T, exists, smbpasswd bool, members []string) *[]string {
	t.Helper()
	pe, pl, pg, pr, ps := hostUserShell, hostLookPath, hostGroupMembers, runArgv, runStdin
	t.Cleanup(func() { hostUserShell, hostLookPath, hostGroupMembers, runArgv, runStdin = pe, pl, pg, pr, ps })
	hostUserShell = func(string) (string, bool) {
		if exists {
			return "/usr/sbin/nologin", true
		}
		return "", false
	}
	hostLookPath = func(name string) bool { return name != "smbpasswd" || smbpasswd }
	hostGroupMembers = func(string) []string { return members }
	var ran []string
	runArgv = func(argv []string) ([]byte, error) { ran = append(ran, strings.Join(argv, " ")); return nil, nil }
	runStdin = func(argv []string, stdin string) ([]byte, error) {
		ran = append(ran, strings.Join(argv, " ")+" <stdin:"+stdin+">")
		return nil, nil
	}
	return &ran
}

func TestPlanUserCreate(t *testing.T) {
	ran := stubUserHost(t, false, true, nil)
	p, fe := build(t, planUserCreate, `{"username":"alice","password":"s3cret pass","samba":true}`)
	if fe != nil {
		t.Fatal(fe)
	}
	want := [][]string{{"useradd", "-M", "-s", "/sbin/nologin", "alice"}, {"chpasswd"}, {"smbpasswd", "-s", "-a", "alice"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	if p.Steps[1].OnFailure != "warn" || p.Steps[2].OnFailure != "warn" {
		t.Fatal("password steps only warn")
	}
	for _, s := range p.Steps {
		if strings.Contains(s.Summary+strings.Join(s.Command, " ")+s.Diff, "s3cret") {
			t.Fatalf("password leaked into a step: %+v", s)
		}
	}
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("plan failed")
	}
	wantRan := []string{"useradd -M -s /sbin/nologin alice", "chpasswd <stdin:alice:s3cret pass\n>", "smbpasswd -s -a alice <stdin:s3cret pass\ns3cret pass\n>"}
	if !reflect.DeepEqual(*ran, wantRan) {
		t.Fatalf("executed: %q", *ran)
	}
}

func TestPlanUserCreateExistingNoSamba(t *testing.T) {
	stubUserHost(t, true, false, nil)
	p, fe := build(t, planUserCreate, `{"username":"alice","password":"x","samba":true}`)
	if fe != nil || !reflect.DeepEqual(argvs(p), [][]string{{"chpasswd"}}) {
		t.Fatalf("existing account, no smbpasswd: %v %v", fe, argvs(p))
	}
	p, _ = build(t, planUserCreate, `{"username":"alice","password":"x","samba":false}`)
	if len(argvs(p)) != 1 {
		t.Fatal("samba=false must not set a Samba password")
	}
}

func TestPlanUserCreateFingerprintIgnoresPassword(t *testing.T) {
	stubUserHost(t, false, true, nil)
	a := []byte(`{"username":"alice","password":"one","samba":true}`)
	b := []byte(`{"username":"alice","password":"two","samba":true}`)
	pa, _ := planUserCreate(a)
	pb, _ := planUserCreate(b)
	if pa.fingerprint(a) != pb.fingerprint(b) {
		t.Fatal("the fingerprint must not depend on the password")
	}
	if strings.Contains(string(pa.FingerprintInput), "one") {
		t.Fatal("the fingerprint input must not carry the password")
	}
	stubUserHost(t, true, true, nil)
	pc, _ := planUserCreate(a)
	if pa.fingerprint(a) == pc.fingerprint(a) {
		t.Fatal("an account created meanwhile must make the plan stale")
	}
}

func TestPlanUserCreateRefusals(t *testing.T) {
	stubUserHost(t, false, true, nil)
	_, fe := build(t, planUserCreate, `{"username":"Bad","password":"x"}`)
	wantErr(t, fe, "ERR")
	_, fe = build(t, planUserCreate, `{"username":"alice","password":"a\nb"}`)
	wantErr(t, fe, "ERR")
	_, fe = build(t, planUserCreate, `{"username":"alice","password":""}`)
	wantErr(t, fe, "ERR")
}

func TestPlanGroupLeave(t *testing.T) {
	stubUserHost(t, true, true, []string{"bob", "alice"})
	p, fe := build(t, planGroupLeave, `{"username":"alice"}`)
	if fe != nil || !reflect.DeepEqual(argvs(p), [][]string{{"gpasswd", "-d", "alice", "hsi-share"}}) {
		t.Fatalf("member: %v %v", fe, argvs(p))
	}
	assertParity(t, p)
	stubUserHost(t, true, true, []string{"bob"})
	p, _ = build(t, planGroupLeave, `{"username":"alice"}`)
	if len(p.Steps) != 0 {
		t.Fatal("a non-member has nothing to leave")
	}
}

func TestPlanUserCreateRefusesLoginAccounts(t *testing.T) {
	stubUserHost(t, true, true, nil)
	hostUserShell = func(string) (string, bool) { return "/bin/bash", true }
	_, fe := build(t, planUserCreate, `{"username":"theophile","password":"x","samba":true}`)
	if fe == nil || !strings.Contains(fe.Message, "not managed by HSI") {
		t.Fatalf("an existing login account must not get its password replaced: %+v", fe)
	}
	hostUserShell = func(string) (string, bool) { return "/usr/sbin/nologin", true }
	p, fe := build(t, planUserCreate, `{"username":"alice","password":"x","samba":true}`)
	if fe != nil || !strings.Contains(p.Steps[0].Summary, "already exists") {
		t.Fatalf("an existing HSI-style account is reused, and the plan says so: %v %+v", fe, p)
	}
}

func TestUserShellFromPasswd(t *testing.T) {
	passwd := "root:x:0:0:root:/root:/bin/bash\nalice:x:1001:1001::/home/alice:/usr/sbin/nologin\n"
	if sh, ok := shellFromPasswd(passwd, "alice"); !ok || sh != "/usr/sbin/nologin" {
		t.Fatalf("alice: %q %v", sh, ok)
	}
	if _, ok := shellFromPasswd(passwd, "bob"); ok {
		t.Fatal("bob does not exist")
	}
}

func TestPasswordTargetMustBeHSIAccount(t *testing.T) {
	stubUserHost(t, true, true, nil)
	hostUserShell = func(string) (string, bool) { return "/bin/bash", true }
	if err := checkPasswordTarget("theophile"); err == nil {
		t.Fatal("a login account's password must never be set by HSI")
	}
	hostUserShell = func(string) (string, bool) { return "/usr/sbin/nologin", true }
	if err := checkPasswordTarget("alice"); err != nil {
		t.Fatal(err)
	}
	hostUserShell = func(string) (string, bool) { return "", false }
	if err := checkPasswordTarget("bob"); err != nil {
		t.Fatal("a missing account is created by HSI afterwards")
	}
}
