package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The path guard every impersonated file operation goes through: absolute
// paths only, no null byte, nothing that resolves outside the Place root.
func TestValidatePathsScoped(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path, code string
	}{
		{filepath.Join(root, "docs"), ""},
		{filepath.Join(root, "docs", "new-file"), ""}, // destination that does not exist yet
		{root, ""},           // the root itself
		{"docs/file", "ERR"}, // relative
		{filepath.Join(root, "docs") + "\x00", "ERR"},                 // null byte
		{filepath.Join(root, "..", filepath.Base(outside)), "EACCES"}, // .. out of the root
		{filepath.Join(root, "escape", "secret"), "EACCES"},           // symlink out of the root
		{root + "-sibling", "EACCES"},                                 // shares the prefix only
	}
	for _, c := range cases {
		fe := validatePathsScoped(root, c.path)
		got := ""
		if fe != nil {
			got = fe.Code
		}
		if got != c.code {
			t.Errorf("%q: got %q, want %q (%v)", c.path, got, c.code, fe)
		}
	}
	if fe := validatePathsScoped("", "/etc/shadow"); fe != nil {
		t.Errorf("an empty root is unrestricted: %v", fe)
	}
}
