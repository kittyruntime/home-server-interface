package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsFreshVolumeRoot(t *testing.T) {
	cases := []struct {
		entries []string
		want    bool
	}{
		{nil, true},
		{[]string{"lost+found"}, true},
		{[]string{"lost+found", "photos"}, false},
		{[]string{".snapshots"}, false},
	}
	for _, c := range cases {
		if got := isFreshVolumeRoot(c.entries); got != c.want {
			t.Errorf("isFreshVolumeRoot(%v) = %v, want %v", c.entries, got, c.want)
		}
	}
}

func TestPrepareVolumeRootLeavesDataAlone(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "photo.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Without force, a volume that holds data (or that is not owned by root,
	// as a test directory is when run unprivileged) is never changed.
	if w := prepareVolumeRoot(dir, "nobody", false); len(w) != 1 {
		t.Fatalf("want one warning, got %v", w)
	}
	st, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o755 || st.Mode()&os.ModeSetgid != 0 {
		t.Errorf("mode changed to %v", st.Mode())
	}
}
