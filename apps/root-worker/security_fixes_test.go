package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// The LCS table is quadratic: a huge file is summed up, not diffed.
func TestUnifiedDiffTooLarge(t *testing.T) {
	big := strings.Repeat("x\n", maxDiffLines+1)
	got := unifiedDiff("/etc/fstab", big, big+"y\n")
	if !strings.Contains(got, "too large to show as a diff") || !strings.HasPrefix(got, "--- a/etc/fstab\n") {
		t.Fatalf("summary: %q", got)
	}
	if d := unifiedDiff("/etc/fstab", "a\n", "b\n"); !strings.Contains(d, "-a") || !strings.Contains(d, "+b") {
		t.Fatalf("small files still diffed: %q", d)
	}
}

// Zip entries are checked with filepath.IsLocal, which keeps "." and plain
// relative names.
func TestZipEntryLocality(t *testing.T) {
	for _, ok := range []string{".", "a", "a/b", "a/../b"} {
		if !filepath.IsLocal(filepath.Clean(filepath.FromSlash(ok))) {
			t.Errorf("%s should be extracted", ok)
		}
	}
	for _, bad := range []string{"..", "../a", "a/../../b", "/etc/passwd"} {
		if filepath.IsLocal(filepath.Clean(filepath.FromSlash(bad))) {
			t.Errorf("%s should be refused", bad)
		}
	}
}
