package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// stubNfsHost: Samba installed or not, exportfs present or not, and the
// current exports file ("" = none).
func stubNfsHost(t *testing.T, smbd, exportfs bool, current string) *map[string]string {
	t.Helper()
	written := stubSmbHost(t, "", true, true)
	hostSmbdInstalled = func() bool { return smbd }
	pr, pl, pi, prm := hostReadFile, hostLookPath, hostNfsIDsFn, hostRemoveFile
	t.Cleanup(func() { hostReadFile, hostLookPath, hostNfsIDsFn, hostRemoveFile = pr, pl, pi, prm })
	hostReadFile = func(p string) ([]byte, error) {
		if p == nfsExportsPath && current != "" {
			return []byte(current), nil
		}
		return pr(p)
	}
	hostLookPath = func(n string) bool { return n == "exportfs" && exportfs }
	hostNfsIDsFn = func() (nfsIDs, error) { return nfsIDsStub(), nil }
	prp := hostSafeFolder
	t.Cleanup(func() { hostSafeFolder = prp })
	hostSafeFolder = func(string) error { return nil }
	hostRemoveFile = func(p string) error { (*written)[p] = "<removed>"; return nil }
	return written
}

const nfsOnly = `{"shares":[],"nfs":{"exports":[{"path":"/srv/films","clients":["192.168.1.0/24"],"writeAs":"alice","fsid":"` + fsidA + `"}]}}`

func TestPlanShareSyncExportsWithoutSamba(t *testing.T) {
	written := stubNfsHost(t, false, true, "")
	p, fe := build(t, planSmbSync, nfsOnly)
	if fe != nil {
		t.Fatal(fe)
	}
	if p.Steps[0].Target != nfsExportsPath || p.Steps[0].Kind != "create" {
		t.Fatalf("first step: %+v", p.Steps[0])
	}
	want := [][]string{{"exportfs", "-ra"}, {"systemctl", "enable", "--now", "nfs-server"}}
	if !reflect.DeepEqual(argvs(p), want) {
		t.Fatalf("commands: %v", argvs(p))
	}
	assertParity(t, p)
	if !strings.Contains((*written)[nfsExportsPath], `"/srv/films" 192.168.1.0/24(rw,`) {
		t.Fatalf("exports: %q", (*written)[nfsExportsPath])
	}
	for path := range *written {
		if strings.Contains(path, "samba") {
			t.Fatal("Samba configured without Samba or SMB shares")
		}
	}
}

func TestPlanShareSyncNeedsExportfs(t *testing.T) {
	stubNfsHost(t, true, false, "")
	_, fe := build(t, planSmbSync, nfsOnly)
	wantErr(t, fe, "NFS_MISSING")
}

func TestPlanShareSyncRemovesTheLastExport(t *testing.T) {
	written := stubNfsHost(t, false, true, "# Managed by HSI\n\"/srv/films\" 10.0.0.1(ro)\n")
	p, fe := build(t, planSmbSync, `{"shares":[],"nfs":{"exports":[]}}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if p.Steps[0].Kind != "delete" || p.Steps[0].Target != nfsExportsPath {
		t.Fatalf("first step: %+v", p.Steps[0])
	}
	if !reflect.DeepEqual(argvs(p), [][]string{{"exportfs", "-ra"}}) {
		t.Fatalf("the service is never stopped: %v", argvs(p))
	}
	assertParity(t, p)
	if (*written)[nfsExportsPath] != "<removed>" {
		t.Fatal("exports file kept")
	}
}

func TestPlanShareSyncUnchangedExportsDoNothing(t *testing.T) {
	cur, _ := renderExports([]nfsExportDef{{Path: "/srv/films", Clients: []string{"192.168.1.0/24"}, WriteAs: "alice", Fsid: fsidA}}, nfsIDsStub())
	stubNfsHost(t, false, true, cur)
	p, fe := build(t, planSmbSync, nfsOnly)
	if fe != nil {
		t.Fatal(fe)
	}
	if len(p.Steps) != 0 {
		t.Fatalf("steps for an unchanged export: %+v", p.Steps)
	}
}

func TestPlanShareSyncStillNeedsSambaForSmbShares(t *testing.T) {
	stubNfsHost(t, false, true, "")
	_, fe := build(t, planSmbSync, `{"shares":[{"name":"media","path":"/srv/media","validUsers":["alice"]}],"nfs":{"exports":[]}}`)
	wantErr(t, fe, "SMBD_MISSING")
}

func TestPlanShareSyncLeavesOutASymlinkedExport(t *testing.T) {
	written := stubNfsHost(t, false, true, "")
	pr := hostSafeFolder
	t.Cleanup(func() { hostSafeFolder = pr })
	hostSafeFolder = func(string) error { return errors.New("a symbolic link") }
	p, fe := build(t, planSmbSync, nfsOnly)
	if fe != nil {
		t.Fatal(fe)
	}
	assertParity(t, p)
	if strings.Contains((*written)[nfsExportsPath], "/srv/films") {
		t.Fatalf("a folder swapped for a link is exported: %q", (*written)[nfsExportsPath])
	}
}
