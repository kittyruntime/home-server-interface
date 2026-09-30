package main

import (
	"reflect"
	"strings"
	"testing"
)

func stubUserHost(t *testing.T, exists, smbpasswd bool, members []string) *[]string {
	t.Helper()
	pe, pl, pg, pr, ps := hostUserExists, hostLookPath, hostGroupMembers, runArgv, runStdin
	t.Cleanup(func() { hostUserExists, hostLookPath, hostGroupMembers, runArgv, runStdin = pe, pl, pg, pr, ps })
	hostUserExists = func(string) bool { return exists }
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
