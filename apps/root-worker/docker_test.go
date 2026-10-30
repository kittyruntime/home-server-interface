package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestComposeNameValidation(t *testing.T) {
	for _, ok := range []string{"jellyfin", "jelly-fin", "jelly.fin2"} {
		if _, err := composeFilePath(ok); err != nil {
			t.Errorf("expected %q valid, got %v", ok, err)
		}
	}
	for _, bad := range []string{"", "..", "../etc", "a/b", "-lead", "a b", "Jellyfin", strings.Repeat("x", 65)} {
		if _, err := composeFilePath(bad); err == nil {
			t.Errorf("expected %q rejected", bad)
		}
	}
}

func TestComposeArgsAreScopedToStacksDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envStacksDir, dir)
	args, err := composeArgs("jellyfin", "up", "-d")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"compose", "-f", filepath.Join(dir, "jellyfin", "compose.yaml"), "up", "-d"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Fatalf("got %v want %v", args, want)
	}
}
