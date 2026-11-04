package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newPlace(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "place")
	if err := os.MkdirAll(filepath.Join(root, "docs", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"docs/a.txt", "docs/sub/b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestTrashRestoreRoundTrip(t *testing.T) {
	root := newPlace(t)
	now := time.Date(2026, 11, 4, 10, 0, 0, 0, time.Local)
	e, fe := doTrash(root, filepath.Join(root, "docs"), "alice", now)
	if fe != nil {
		t.Fatal(fe)
	}
	if e.ID != currentUID()+":docs" || e.Type != "dir" || e.DeletedBy != "alice" {
		t.Fatalf("entry = %+v", e)
	}
	if _, err := os.Stat(filepath.Join(root, "docs")); !os.IsNotExist(err) {
		t.Fatal("the folder must have left its place")
	}

	list, fe := doTrashList(root)
	if fe != nil || len(list) != 1 || list[0].OriginalPath != filepath.Join(root, "docs") {
		t.Fatalf("list = %+v, %v", list, fe)
	}

	dst, fe := doTrashRestore(root, e.ID, "")
	if fe != nil || dst != filepath.Join(root, "docs") {
		t.Fatalf("restore = %q, %v", dst, fe)
	}
	if b, err := os.ReadFile(filepath.Join(root, "docs", "sub", "b.txt")); err != nil || string(b) != "docs/sub/b.txt" {
		t.Fatal("restored content differs")
	}
	if list, _ := doTrashList(root); len(list) != 0 {
		t.Fatalf("trash not empty after restore: %+v", list)
	}
}

func TestTrashSameNameGetsANewID(t *testing.T) {
	root := newPlace(t)
	now := time.Now()
	if _, fe := doTrash(root, filepath.Join(root, "c.txt"), "", now); fe != nil {
		t.Fatal(fe)
	}
	if err := os.WriteFile(filepath.Join(root, "c.txt"), []byte("again"), 0o644); err != nil {
		t.Fatal(err)
	}
	e, fe := doTrash(root, filepath.Join(root, "c.txt"), "", now)
	if fe != nil || e.ID != currentUID()+":c.txt.2" {
		t.Fatalf("second id = %+v, %v", e, fe)
	}
}

func TestTrashRestoreNeverOverwrites(t *testing.T) {
	root := newPlace(t)
	e, fe := doTrash(root, filepath.Join(root, "c.txt"), "", time.Now())
	if fe != nil {
		t.Fatal(fe)
	}
	if err := os.WriteFile(filepath.Join(root, "c.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, fe := doTrashRestore(root, e.ID, ""); fe == nil || fe.Code != "EEXIST" {
		t.Fatalf("restore over an existing file = %v", fe)
	}
	dst, fe := doTrashRestore(root, e.ID, filepath.Join(root, "c (restored).txt"))
	if fe != nil || filepath.Base(dst) != "c (restored).txt" {
		t.Fatalf("restore elsewhere = %q, %v", dst, fe)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "c.txt")); string(b) != "new" {
		t.Fatal("the existing file was touched")
	}
}

func TestTrashRefusesPlaceRootTrashAndOutside(t *testing.T) {
	root := newPlace(t)
	if _, fe := doTrash(root, root, "", time.Now()); fe == nil {
		t.Error("the place itself cannot go to the trash")
	}
	if _, fe := doTrash(root, filepath.Join(filepath.Dir(root), "x"), "", time.Now()); fe == nil {
		t.Error("an item outside the place cannot go to its trash")
	}
	if _, fe := doTrash(root, filepath.Join(root, "c.txt"), "", time.Now()); fe != nil {
		t.Fatal(fe)
	}
	if _, fe := doTrash(root, filepath.Join(root, trashDirName), "", time.Now()); fe == nil {
		t.Error("the trash cannot go to the trash")
	}
	if _, fe := doTrashRestore(root, currentUID()+":../c.txt", ""); fe == nil {
		t.Error("ids cannot leave the trash")
	}
	if _, fe := doTrashRestore(root, currentUID()+":c.txt", "/etc/passwd"); fe == nil {
		t.Error("an item is restored inside its place only")
	}
}

func TestTrashPurgeAndEmpty(t *testing.T) {
	root := newPlace(t)
	old := time.Now().AddDate(0, 0, -40)
	if _, fe := doTrash(root, filepath.Join(root, "c.txt"), "", old); fe != nil {
		t.Fatal(fe)
	}
	if _, fe := doTrash(root, filepath.Join(root, "docs"), "", time.Now()); fe != nil {
		t.Fatal(fe)
	}
	// An interrupted move: info without an item.
	_, _, info := userTrash(root, currentUID())
	if err := os.WriteFile(filepath.Join(info, "ghost"+trashInfoExt), []byte(encodeTrashInfo(root+"/ghost", time.Now(), "")), 0o644); err != nil {
		t.Fatal(err)
	}
	n, fe := doTrashPurge(root, time.Now().AddDate(0, 0, -30))
	if fe != nil || n != 1 {
		t.Fatalf("purge removed %d, %v", n, fe)
	}
	if _, err := os.Stat(filepath.Join(info, "ghost"+trashInfoExt)); !os.IsNotExist(err) {
		t.Error("an orphan info file must be cleaned")
	}
	list, _ := doTrashList(root)
	if len(list) != 1 || list[0].ID != currentUID()+":docs" {
		t.Fatalf("after purge = %+v", list)
	}
	if fe := doTrashEmpty(root); fe != nil {
		t.Fatal(fe)
	}
	if list, _ := doTrashList(root); len(list) != 0 {
		t.Fatalf("after empty = %+v", list)
	}
}

func TestTrashInfoRoundTrip(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.Local)
	ti, err := parseTrashInfo(encodeTrashInfo("/srv/a b/\u00e9%.txt", at, "jean-baptiste"))
	if err != nil || ti.Path != "/srv/a b/\u00e9%.txt" || !ti.DeletedAt.Equal(at) || ti.DeletedBy != "jean-baptiste" {
		t.Fatalf("round trip = %+v, %v", ti, err)
	}
	if _, err := parseTrashInfo("Path=/x"); err == nil {
		t.Error("a file without the header is not a trash info")
	}
}

func TestTrashSymlinkRefused(t *testing.T) {
	root := newPlace(t)
	if err := os.Symlink(t.TempDir(), filepath.Join(root, trashDirName)); err != nil {
		t.Fatal(err)
	}
	if _, fe := doTrash(root, filepath.Join(root, "c.txt"), "", time.Now()); fe == nil {
		t.Error("moving into a symlinked trash must fail")
	}
}

func TestTrashEmptyNeverFollowsASwappedFolder(t *testing.T) {
	root := newPlace(t)
	if _, fe := doTrash(root, filepath.Join(root, "c.txt"), "", time.Now()); fe != nil {
		t.Fatal(fe)
	}
	// A writer swaps the trash's files folder for a link to data elsewhere.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "precious"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, files, _ := userTrash(root, currentUID())
	if err := os.RemoveAll(files); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, files); err != nil {
		t.Fatal(err)
	}
	if fe := doTrashEmpty(root); fe == nil {
		t.Error("emptying through a symlinked folder must fail")
	}
	if _, fe := doTrashPurge(root, time.Now().Add(time.Hour)); fe == nil {
		t.Error("purging through a symlinked folder must fail")
	}
	if _, err := os.Stat(filepath.Join(outside, "precious")); err != nil {
		t.Fatal("data outside the trash was removed")
	}
}

func TestTrashRestoreRefusesASymlinkedParent(t *testing.T) {
	root := newPlace(t)
	if _, fe := doTrash(root, filepath.Join(root, "docs", "a.txt"), "", time.Now()); fe != nil {
		t.Fatal(fe)
	}
	outside := t.TempDir()
	if err := os.RemoveAll(filepath.Join(root, "docs")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "docs")); err != nil {
		t.Fatal(err)
	}
	if _, fe := doTrashRestore(root, currentUID()+":a.txt", ""); fe == nil {
		t.Error("a restore through a symlinked folder must be refused")
	}
	if _, err := os.Stat(filepath.Join(outside, "a.txt")); err == nil {
		t.Error("the item was restored outside the place")
	}
}

func TestTrashIsPrivateToItsUser(t *testing.T) {
	root := newPlace(t)
	if _, fe := doTrash(root, filepath.Join(root, "c.txt"), "", time.Now()); fe != nil {
		t.Fatal(fe)
	}
	dir, files, info := userTrash(root, currentUID())
	for _, d := range []string{dir, files, info} {
		fi, err := os.Stat(d)
		if err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("%s mode = %v, want 0700", d, fi.Mode().Perm())
		}
	}
	top, _ := os.Stat(trashRoot(root))
	if top.Mode()&os.ModeSticky == 0 {
		t.Error("the shared trash folder must be sticky")
	}
	// Another user's folder is out of reach of this one's operations.
	if _, fe := doTrashRestore(root, "4242:c.txt", ""); fe == nil {
		t.Error("an item of another user's trash must not be restored")
	}
}

func TestTrashPathsAreRefusedToFileOperations(t *testing.T) {
	for _, p := range []string{"/srv/media/.hsi-trash", "/srv/media/.hsi-trash/1000/files/x"} {
		if validatePath(p) == nil {
			t.Errorf("%s must be refused", p)
		}
	}
	if validatePath("/srv/media/.hsi-trash2/x") != nil {
		t.Error("a name that only starts like the trash is a normal path")
	}
}
