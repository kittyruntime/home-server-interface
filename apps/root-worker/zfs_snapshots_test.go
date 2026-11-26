package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const snapList = "tank/media@hsi-daily-20261120-0300\t1763607600\t1024\t4096\n" +
	"tank/media@mine\t1763694000\t0\t4096\n" +
	"tank/media@hsi-daily-20261122-0300\t1763780400\t2048\t8192\n" +
	"tank/media@hsi-daily-20261123-0300\t1763866800\t0\t8192\n" +
	"tank/docs@hsi-hourly-20261123-0900\t1763888400\t0\t100\n"

func TestParseZfsSnapshots(t *testing.T) {
	s := parseZfsSnapshots(snapList)
	if len(s) != 5 || s[0].Dataset != "tank/media" || s[0].Short != "hsi-daily-20261120-0300" || s[0].Created != 1763607600 || s[2].Used != 2048 || s[2].Refer != 8192 {
		t.Fatalf("%+v", s)
	}
}

func TestCleanSnapPath(t *testing.T) {
	for in, want := range map[string]string{"": "", "a/b": "a/b", "a//b/": "a/b", "./a": "a"} {
		if got, ok := cleanSnapPath(in); !ok || got != want {
			t.Errorf("%q gave %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"/etc", "..", "../x", "a/../../x", "a/..", "a\x00b"} {
		if _, ok := cleanSnapPath(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

// stubSnapHost: a dataset mounted at a temp folder holding the snapshot "s1".
func stubSnapHost(t *testing.T) (mount string, ran *[]string) {
	t.Helper()
	mount = t.TempDir()
	root := filepath.Join(mount, ".zfs", "snapshot", "s1")
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "dir", "sub"), 0o755))
	must(os.WriteFile(filepath.Join(root, "dir", "photo.jpg"), []byte("x"), 0o644))
	must(os.Symlink("/etc", filepath.Join(root, "out")))
	must(os.MkdirAll(filepath.Join(mount, "dir"), 0o755))
	must(os.Symlink("/etc", filepath.Join(mount, "link")))
	prevM, prevO, prevR := snapshotMount, hostOutput, runArgv
	t.Cleanup(func() { snapshotMount, hostOutput, runArgv = prevM, prevO, prevR })
	snapshotMount = func(snapshot string) (string, *fsError) {
		if snapshot != "tank/media@s1" {
			return "", &fsError{Code: "ENOENT", Message: snapshot + " does not exist"}
		}
		return mount, nil
	}
	var r []string
	runArgv = func(argv []string) ([]byte, error) { r = append(r, strings.Join(argv, " ")); return nil, nil }
	return mount, &r
}

func TestSnapshotLsNeverFollowsLinks(t *testing.T) {
	stubSnapHost(t)
	entries, fe := snapshotLs("tank/media@s1", "")
	if fe != nil || len(entries) != 2 {
		t.Fatalf("%+v %v", entries, fe)
	}
	if entries[0].Name != "dir" || entries[0].Kind != "dir" || entries[1].Name != "out" || entries[1].Kind != "link" {
		t.Errorf("%+v", entries)
	}
	if _, fe := snapshotLs("tank/media@s1", "out"); fe == nil {
		t.Error("listing a link out of the snapshot was allowed")
	}
	if _, fe := snapshotLs("tank/media@s1", "../.."); fe == nil {
		t.Error("a path out of the snapshot was allowed")
	}
	if e, fe := snapshotLs("tank/media@s1", "dir"); fe != nil || len(e) != 2 {
		t.Errorf("%+v %v", e, fe)
	}
}

func TestRestoredName(t *testing.T) {
	at := time.Date(2026, 11, 26, 10, 5, 0, 0, time.Local)
	if got := restoredName("photo.jpg", false, at); got != "photo (restored 2026-11-26 10-05).jpg" {
		t.Error(got)
	}
	if got := restoredName("Photos", true, at); got != "Photos (restored 2026-11-26 10-05)" {
		t.Error(got)
	}
	if got := restoredName(".bashrc", false, at); got != ".bashrc (restored 2026-11-26 10-05)" {
		t.Error(got)
	}
}

func TestPlanSnapshotRestore(t *testing.T) {
	mount, _ := stubSnapHost(t)
	prev := zfsNow
	t.Cleanup(func() { zfsNow = prev })
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 5, 0, 0, time.Local) }
	p, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/photo.jpg"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if len(p.Steps) != 1 || p.Steps[0].Target != filepath.Join(mount, "dir", "photo (restored 2026-11-26 10-05).jpg") {
		t.Errorf("%+v", p.Steps)
	}
	if _, err := p.Steps[0].run(); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(mount, "dir", "photo (restored 2026-11-26 10-05).jpg")); err != nil || string(b) != "x" {
		t.Errorf("not restored: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(mount, "dir")); len(entries) != 1 {
		t.Errorf("a temporary folder was left: %v", entries)
	}
	// Once restored, the same name exists: never overwritten.
	if _, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/photo.jpg"}`)); fe == nil {
		t.Error("an existing restored copy would be overwritten")
	}
	for _, bad := range []string{`"out/passwd"`, `""`, `"../x"`, `"nothing"`} {
		if _, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":` + bad + `}`)); fe == nil {
			t.Errorf("restore of %s accepted", bad)
		}
	}
	// A folder whose live parent is a link: refused (it would write elsewhere).
	if err := os.MkdirAll(filepath.Join(mount, ".zfs", "snapshot", "s1", "link"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mount, ".zfs", "snapshot", "s1", "link", "f"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"link/f"}`)); fe == nil {
		t.Error("a restore through a linked live folder was accepted")
	}
}

func stubSnapList(t *testing.T, list string) *[]string {
	t.Helper()
	prevA, prevO, prevR, prevN := zfsAvailable, hostOutput, runArgv, zfsNow
	t.Cleanup(func() { zfsAvailable, hostOutput, runArgv, zfsNow = prevA, prevO, prevR, prevN })
	zfsAvailable = func() bool { return true }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		j := strings.Join(args, " ")
		switch {
		case name == "zfs" && strings.Contains(j, "-t snapshot"):
			return []byte(list), nil
		case name == "zfs" && strings.Contains(j, "-t filesystem"):
			return []byte("tank/media\t1\t1\t-\t/srv/tank/media\tyes\tlz4\t1.00x\ton\ntank/docs\t1\t1\t-\t/srv/tank/docs\tyes\tlz4\t1.00x\ton\n"), nil
		}
		return nil, nil
	}
	var r []string
	runArgv = func(argv []string) ([]byte, error) { r = append(r, strings.Join(argv, " ")); return nil, nil }
	return &r
}

func TestPlanZfsSnapshotRollback(t *testing.T) {
	stubSnapList(t, snapList)
	p, fe := planZfsSnapshotRollback([]byte(`{"snapshot":"tank/media@mine"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	s := p.Steps[0]
	if strings.Join(s.Command, " ") != "zfs rollback -r tank/media@mine" || !s.Destructive ||
		!strings.Contains(s.Summary, "hsi-daily-20261122-0300") || !strings.Contains(s.Summary, "hsi-daily-20261123-0300") || strings.Contains(s.Summary, "20261120") {
		t.Errorf("%+v", s)
	}
	if _, fe := planZfsSnapshotRollback([]byte(`{"snapshot":"tank/media@nope"}`)); fe == nil {
		t.Error("a missing snapshot was accepted")
	}
}

func TestPlanZfsSnapshotCreateAndDestroy(t *testing.T) {
	stubSnapList(t, snapList)
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 5, 7, 0, time.Local) }
	p, fe := planZfsSnapshotCreate([]byte(`{"dataset":"tank/media"}`))
	if fe != nil || strings.Join(p.Steps[0].Command, " ") != "zfs snapshot tank/media@hsi-manual-20261126-100507" {
		t.Errorf("%+v %v", p, fe)
	}
	if _, fe := planZfsSnapshotCreate([]byte(`{"dataset":"tank/nope"}`)); fe == nil {
		t.Error("a missing dataset was accepted")
	}
	p, fe = planZfsSnapshotDestroy([]byte(`{"snapshot":"tank/media@mine"}`))
	if fe != nil || strings.Join(p.Steps[0].Command, " ") != "zfs destroy tank/media@mine" || !p.Steps[0].Destructive {
		t.Errorf("%+v %v", p, fe)
	}
	if _, fe := planZfsSnapshotDestroy([]byte(`{"snapshot":"tank/media"}`)); fe == nil {
		t.Error("a dataset (no @) was accepted for destruction")
	}
}

func TestPlanZfsSnapshotRules(t *testing.T) {
	stubSnapList(t, snapList)
	prev := zfsSnapshotRulesPath
	t.Cleanup(func() { zfsSnapshotRulesPath = prev })
	zfsSnapshotRulesPath = filepath.Join(t.TempDir(), "zfs-snapshots.json")
	p, fe := planZfsSnapshotRules([]byte(`{"rules":[{"dataset":"tank/media","every":"daily","keep":7}]}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if _, err := p.Steps[0].run(); err != nil {
		t.Fatal(err)
	}
	if got := loadSnapRules(); len(got) != 1 || got[0].Keep != 7 {
		t.Errorf("%+v", got)
	}
	for _, bad := range []string{
		`[{"dataset":"tank/nope","every":"daily","keep":7}]`,
		`[{"dataset":"tank/media","every":"yearly","keep":7}]`,
		`[{"dataset":"tank/media","every":"daily","keep":0}]`,
		`[{"dataset":"tank/media","every":"daily","keep":7},{"dataset":"tank/media","every":"daily","keep":3}]`,
	} {
		if _, fe := planZfsSnapshotRules([]byte(`{"rules":` + bad + `}`)); fe == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestRunSnapshotRules(t *testing.T) {
	ran := stubSnapList(t, snapList)
	prev := zfsSnapshotRulesPath
	t.Cleanup(func() { zfsSnapshotRulesPath = prev })
	zfsSnapshotRulesPath = filepath.Join(t.TempDir(), "r.json")
	b, _ := json.Marshal([]snapRule{{Dataset: "tank/media", Every: "daily", Keep: 2}, {Dataset: "tank/docs", Every: "hourly", Keep: 5}})
	if err := os.WriteFile(zfsSnapshotRulesPath, b, 0o644); err != nil {
		t.Fatal(err)
	}
	// 2026-11-24 03:00 UTC: a day after the last daily, 18 h after the last hourly.
	zfsNow = func() time.Time { return time.Unix(1763953200, 0) }
	runZfsSnapshotRules()
	want := []string{
		"zfs snapshot tank/media@hsi-daily-" + time.Unix(1763953200, 0).Format("20060102-1504"),
		"zfs destroy tank/media@hsi-daily-20261120-0300",
		"zfs destroy tank/media@hsi-daily-20261122-0300",
		"zfs snapshot tank/docs@hsi-hourly-" + time.Unix(1763953200, 0).Format("20060102-1504"),
	}
	if strings.Join(*ran, "\n") != strings.Join(want, "\n") {
		t.Errorf("ran\n%s\nwant\n%s", strings.Join(*ran, "\n"), strings.Join(want, "\n"))
	}
	// Not due yet: nothing taken, and nothing pruned below keep.
	*ran = nil
	zfsNow = func() time.Time { return time.Unix(1763866800+3600, 0) }
	b, _ = json.Marshal([]snapRule{{Dataset: "tank/media", Every: "daily", Keep: 5}})
	_ = os.WriteFile(zfsSnapshotRulesPath, b, 0o644)
	runZfsSnapshotRules()
	if len(*ran) != 0 {
		t.Errorf("ran %v", *ran)
	}
}
