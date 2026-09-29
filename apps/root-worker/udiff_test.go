package main

import (
	"strings"
	"testing"
)

func TestUnifiedDiffIdentical(t *testing.T) {
	if d := unifiedDiff("/etc/fstab", "a\nb\n", "a\nb\n"); d != "" {
		t.Fatalf("expected empty diff, got %q", d)
	}
}

func TestUnifiedDiffAddedAndRemoved(t *testing.T) {
	before := "one\ntwo\nthree\nfour\n"
	after := "one\ntwo\nTHREE\nfour\nfive\n"
	d := unifiedDiff("/etc/fstab", before, after)
	for _, want := range []string{"--- a/etc/fstab\n", "+++ b/etc/fstab\n", "@@ ", "-three\n", "+THREE\n", "+five\n", " two\n"} {
		if !strings.Contains(d, want) {
			t.Errorf("diff lacks %q:\n%s", want, d)
		}
	}
}

func TestUnifiedDiffRemovalBeforeAddition(t *testing.T) {
	d := unifiedDiff("/f", "a\nb\nc\n", "a\nB\nc\n")
	if !strings.Contains(d, "-b\n+B\n") {
		t.Fatalf("expected -b then +B:\n%s", d)
	}
}
