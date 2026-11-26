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
	prevM, prevO, prevR, prevC := snapshotMount, hostOutput, runArgv, childMountsOf
	t.Cleanup(func() { snapshotMount, hostOutput, runArgv, childMountsOf = prevM, prevO, prevR, prevC })
	childMountsOf = func(string) map[string]bool { return map[string]bool{filepath.Join(mount, "dir", "sub"): true} }
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
	entries, _, fe := snapshotLs("tank/media@s1", "")
	if fe != nil || len(entries) != 2 {
		t.Fatalf("%+v %v", entries, fe)
	}
	if entries[0].Name != "dir" || entries[0].Kind != "dir" || entries[1].Name != "out" || entries[1].Kind != "link" {
		t.Errorf("%+v", entries)
	}
	if _, _, fe := snapshotLs("tank/media@s1", "out"); fe == nil {
		t.Error("listing a link out of the snapshot was allowed")
	}
	if _, _, fe := snapshotLs("tank/media@s1", "../.."); fe == nil {
		t.Error("a path out of the snapshot was allowed")
	}
	if e, _, fe := snapshotLs("tank/media@s1", "dir"); fe != nil || len(e) != 2 || e[1].Name != "sub" || e[1].Kind != "dataset" {
		t.Errorf("a child dataset's mount point shows as such: %+v %v", e, fe)
	}
	if _, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/sub"}`)); fe == nil {
		t.Error("restoring a child dataset's empty mount point was accepted")
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
	if len(p.Steps) != 1 || p.Steps[0].Target != filepath.Join(mount, "dir", "photo (restored <date> <time>).jpg") {
		t.Errorf("%+v", p.Steps)
	}
	// Checked again a minute later at apply time, the plan is the same.
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 6, 0, 0, time.Local) }
	p2, _ := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/photo.jpg"}`))
	if p.fingerprint(nil) != p2.fingerprint(nil) {
		t.Error("the plan changes with the clock: apply would always find it stale")
	}
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 5, 0, 0, time.Local) }
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
	if err := os.WriteFile(filepath.Join(mount, "dir", "photo (restored 2026-11-26 10-05).jpg"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	p, _ = planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/photo.jpg"}`))
	if _, err := p.Steps[0].run(); err == nil {
		t.Error("an existing restored copy was overwritten")
	}
	if b, _ := os.ReadFile(filepath.Join(mount, "dir", "photo (restored 2026-11-26 10-05).jpg")); string(b) != "mine" {
		t.Error("the existing copy changed")
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
	ran := stubSnapList(t, snapList)
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 5, 7, 0, time.Local) }
	p, fe := planZfsSnapshotCreate([]byte(`{"dataset":"tank/media"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 5, 9, 0, time.Local) }
	p2, _ := planZfsSnapshotCreate([]byte(`{"dataset":"tank/media"}`))
	if p.fingerprint(nil) != p2.fingerprint(nil) {
		t.Error("the plan changes with the clock: apply would always find it stale")
	}
	if _, err := p.Steps[0].run(); err != nil || strings.Join(*ran, ";") != "zfs snapshot tank/media@hsi-manual-20261126-100509" {
		t.Errorf("ran %v %v", *ran, err)
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
	// A saved rule of a dataset deleted since does not block saving the others.
	_ = os.WriteFile(zfsSnapshotRulesPath, []byte(`[{"dataset":"tank/gone","every":"daily","keep":7}]`), 0o644)
	if _, fe := planZfsSnapshotRules([]byte(`{"rules":[{"dataset":"tank/gone","every":"daily","keep":7},{"dataset":"tank/media","every":"hourly","keep":3}]}`)); fe != nil {
		t.Errorf("a kept rule of a gone dataset blocked the save: %s", fe.Message)
	}
	for _, bad := range []string{
		`[{"dataset":"tank/nope","every":"daily","keep":7}]`,
		`[{"dataset":"tank/gone","every":"daily","keep":9}]`,
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

// A user of the destination folder swaps the temporary folder for one of
// their own holding a link out, while root copies: the copy still lands
// inside the folder HSI made, and nothing is written through the link.
func TestRestoreSurvivesASwappedTemporaryFolder(t *testing.T) {
	mount, _ := stubSnapHost(t)
	outside := t.TempDir()
	prevC, prevN := copyArgv, zfsNow
	t.Cleanup(func() { copyArgv, zfsNow = prevC, prevN })
	zfsNow = func() time.Time { return time.Date(2026, 11, 26, 10, 5, 0, 0, time.Local) }
	real := copyArgv
	copyArgv = func(dir string, argv []string) ([]byte, error) {
		if argv[0] == "cp" {
			ents, _ := os.ReadDir(filepath.Join(mount, "dir"))
			for _, e := range ents {
				if strings.HasPrefix(e.Name(), ".hsi-restore-") {
					tmp := filepath.Join(mount, "dir", e.Name())
					if err := os.Rename(tmp, filepath.Join(mount, "dir", "junk")); err != nil {
						t.Fatal(err)
					}
					_ = os.Mkdir(tmp, 0o755)
					_ = os.Symlink(outside, filepath.Join(tmp, "x"))
				}
			}
		}
		return real(dir, argv)
	}
	p, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/photo.jpg"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if _, err := p.Steps[0].run(); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("root wrote through the link: %v", ents)
	}
	if b, err := os.ReadFile(filepath.Join(mount, "dir", "photo (restored 2026-11-26 10-05).jpg")); err != nil || string(b) != "x" {
		t.Errorf("not restored where it belongs: %v", err)
	}
}

func TestRestoreGoesOnInTheBackground(t *testing.T) {
	mount, _ := stubSnapHost(t)
	prevC, prevW := copyArgv, restoreWait
	t.Cleanup(func() { copyArgv, restoreWait = prevC, prevW })
	release := make(chan struct{})
	real := copyArgv
	copyArgv = func(dir string, argv []string) ([]byte, error) {
		if argv[0] == "cp" {
			<-release
		}
		return real(dir, argv)
	}
	restoreWait = 50 * time.Millisecond
	p, _ := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir"}`))
	if detail, err := p.Steps[0].run(); err != nil || !strings.Contains(detail, "still copying") {
		t.Fatalf("%q %v", detail, err)
	}
	if _, fe := planZfsSnapshotRestore([]byte(`{"snapshot":"tank/media@s1","path":"dir/photo.jpg"}`)); fe == nil {
		t.Error("a second restore started while one copies")
	}
	close(release)
	for i := 0; i < 100 && restoreBusy.Load(); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if restoreBusy.Load() {
		t.Fatal("the background copy never finished")
	}
	if ents, _ := os.ReadDir(mount); len(ents) < 3 {
		t.Errorf("the folder was not restored: %v", ents)
	}
}

func TestEmptyDirFd(t *testing.T) {
	d := t.TempDir()
	fd, err := openNoLinks(d, "")
	if err != nil {
		t.Fatal(err)
	}
	if !emptyDirFd(fd) {
		t.Error("an empty folder reads as not empty")
	}
	_ = os.WriteFile(filepath.Join(d, "x"), nil, 0o644)
	if emptyDirFd(fd) {
		t.Error("a folder with a file reads as empty")
	}
}

func TestRollbackNamesBookmarksAndRefusesClones(t *testing.T) {
	stubSnapList(t, snapList)
	inner := hostOutput
	props := "tank/media@hsi-daily-20261122-0300\tclones\t\ntank/media@hsi-daily-20261122-0300\tuserrefs\t0\ntank/media@hsi-daily-20261123-0300\tclones\t\ntank/media@hsi-daily-20261123-0300\tuserrefs\t0\n"
	hostOutput = func(name string, args ...string) ([]byte, error) {
		j := strings.Join(args, " ")
		switch {
		case name == "zfs" && strings.Contains(j, "-t bookmark"):
			return []byte("tank/media#old\t1763600000\ntank/media#new\t1763800000\n"), nil
		case name == "zfs" && args[0] == "get":
			return []byte(props), nil
		}
		return inner(name, args...)
	}
	p, fe := planZfsSnapshotRollback([]byte(`{"snapshot":"tank/media@mine"}`))
	if fe != nil {
		t.Fatal(fe.Message)
	}
	if s := p.Steps[0].Summary; !strings.Contains(s, "#new") || strings.Contains(s, "#old") {
		t.Errorf("the newer bookmark is named, not the older: %s", s)
	}
	props = strings.Replace(props, "20261123-0300\tclones\t\n", "20261123-0300\tclones\ttank/copy\n", 1)
	if _, fe := planZfsSnapshotRollback([]byte(`{"snapshot":"tank/media@mine"}`)); fe == nil || !strings.Contains(fe.Message, "tank/copy") {
		t.Errorf("a newer snapshot with a clone was accepted: %v", fe)
	}
	props = strings.Replace(props, "tank/copy", "", 1)
	props = strings.Replace(props, "20261122-0300\tuserrefs\t0", "20261122-0300\tuserrefs\t1", 1)
	if _, fe := planZfsSnapshotRollback([]byte(`{"snapshot":"tank/media@mine"}`)); fe == nil || !strings.Contains(fe.Message, "hold") {
		t.Errorf("a newer snapshot with a hold was accepted: %v", fe)
	}
}
