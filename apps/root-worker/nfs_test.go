package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const fsidA = "8c1f2a4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b"

func nfsIDsStub() nfsIDs {
	return nfsIDs{
		uid: func(name string) (int, error) {
			switch name {
			case "alice":
				return 1001, nil
			case "nobody":
				return 65534, nil
			}
			return 0, errors.New("unknown user")
		},
		shareGID: 1500,
	}
}

func TestRenderExportsWritable(t *testing.T) {
	got, err := renderExports([]nfsExportDef{{Path: "/srv/films", Clients: []string{"192.168.1.0/24", "10.0.0.5"}, WriteAs: "alice", Fsid: fsidA}}, nfsIDsStub())
	if err != nil {
		t.Fatal(err)
	}
	opts := "(rw,sync,no_subtree_check,insecure,all_squash,anonuid=1001,anongid=1500,fsid=" + fsidA + ")"
	want := `"/srv/films" 192.168.1.0/24` + opts + ` 10.0.0.5` + opts + "\n"
	if !strings.HasPrefix(got, "# Managed by HSI") || !strings.HasSuffix(got, want) {
		t.Fatalf("got:\n%s\nwant suffix:\n%s", got, want)
	}
}

func TestRenderExportsReadOnlyBelongsToNobody(t *testing.T) {
	got, err := renderExports([]nfsExportDef{{Path: "/srv/films", Clients: []string{"192.168.1.0/24"}, Fsid: fsidA}}, nfsIDsStub())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "(ro,sync,no_subtree_check,insecure,all_squash,anonuid=65534,anongid=1500,") {
		t.Fatalf("read-only export:\n%s", got)
	}
}

func TestRenderExportsLeavesOutUnavailableAndSorts(t *testing.T) {
	got, err := renderExports([]nfsExportDef{
		{Path: "/srv/z", Clients: []string{"10.0.0.1"}, Fsid: fsidA},
		{Path: "/srv/gone", Clients: []string{"10.0.0.1"}, Fsid: fsidA, Unavailable: true},
		{Path: "/srv/a b", Clients: []string{"10.0.0.1"}, Fsid: fsidA},
	}, nfsIDsStub())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "/srv/gone") {
		t.Fatal("a held volume is exported")
	}
	if strings.Index(got, `"/srv/a b"`) > strings.Index(got, `"/srv/z"`) {
		t.Fatalf("not sorted by path:\n%s", got)
	}
}

func TestRenderExportsNothingIsEmpty(t *testing.T) {
	got, err := renderExports(nil, nfsIDsStub())
	if err != nil || got != "" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestRenderExportsRefusals(t *testing.T) {
	ok := nfsExportDef{Path: "/srv/films", Clients: []string{"10.0.0.1"}, Fsid: fsidA}
	many := make([]string, 17)
	for i := range many {
		many[i] = "10.0.0.1"
	}
	cases := map[string]func(e *nfsExportDef){
		"star":          func(e *nfsExportDef) { e.Clients = []string{"*"} },
		"whole v4":      func(e *nfsExportDef) { e.Clients = []string{"0.0.0.0/0"} },
		"whole v6":      func(e *nfsExportDef) { e.Clients = []string{"::/0"} },
		"hostname":      func(e *nfsExportDef) { e.Clients = []string{"pc.lan"} },
		"option inject": func(e *nfsExportDef) { e.Clients = []string{"10.0.0.1(rw,no_root_squash)"} },
		"no client":     func(e *nfsExportDef) { e.Clients = nil },
		"too many":      func(e *nfsExportDef) { e.Clients = many },
		"quote in path": func(e *nfsExportDef) { e.Path = `/srv/a"b` },
		"newline":       func(e *nfsExportDef) { e.Path = "/srv/a\nb" },
		"relative":      func(e *nfsExportDef) { e.Path = "srv/a" },
		"bad fsid":      func(e *nfsExportDef) { e.Fsid = "1,no_root_squash" },
		"root owner":    func(e *nfsExportDef) { e.WriteAs = "root" },
	}
	for name, mutate := range cases {
		e := ok
		mutate(&e)
		if _, err := renderExports([]nfsExportDef{e}, nfsIDsStub()); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRenderExportsGoneOwnerIsReadOnly(t *testing.T) {
	// One stale value must never stop every sync: the export stays, read-only.
	got, err := renderExports([]nfsExportDef{{Path: "/srv/films", Clients: []string{"10.0.0.1"}, WriteAs: "mallory", Fsid: fsidA}}, nfsIDsStub())
	if err != nil || !strings.Contains(got, "(ro,") || !strings.Contains(got, "anonuid=65534,") {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestNfsClientAddress(t *testing.T) {
	cases := map[string]string{
		"clientid: 0xabc\naddress: \"192.168.1.47:776\"\nstatus: confirmed\n": "192.168.1.47",
		"address: \"[fd00::5]:801\"\n":                                        "fd00::5",
		"status: courtesy\n":                                                  "",
	}
	for info, want := range cases {
		if got := nfsClientAddress(info); got != want {
			t.Errorf("%q: got %q, want %q", info, got, want)
		}
	}
}

func TestNfsClientsListsEachMachineOnce(t *testing.T) {
	dir := t.TempDir()
	for i, info := range []string{"address: \"10.0.0.2:700\"\n", "address: \"10.0.0.1:800\"\n", "address: \"10.0.0.2:701\"\n"} {
		sub := filepath.Join(dir, strconv.Itoa(i))
		_ = os.MkdirAll(sub, 0o755)
		_ = os.WriteFile(filepath.Join(sub, "info"), []byte(info), 0o644)
	}
	if got := nfsClients(dir); !reflect.DeepEqual(got, []string{"10.0.0.1", "10.0.0.2"}) {
		t.Fatalf("got %v", got)
	}
	if got := nfsClients(filepath.Join(dir, "missing")); len(got) != 0 {
		t.Fatalf("no nfsd: %v", got)
	}
}
