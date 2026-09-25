package main

import (
	"os"
	"testing"
)

func TestFormatPermissionContext(t *testing.T) {
	got := formatPermissionContext("/mnt/data", "admin", "root", "root", os.ModeDir|0o755)
	want := ` (ran as "admin"; /mnt/data is owned by root:root with mode 0755)`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := formatPermissionContext("/srv", "", "root", "hsi-share", os.ModeDir|os.ModeSetgid|0o775); got != ` (ran as root; /srv is owned by root:hsi-share with mode 2775)` {
		t.Errorf("setgid: got %q", got)
	}
}

func TestPermissionTargetDir(t *testing.T) {
	cases := []struct {
		task taskMsg
		want string
	}{
		{taskMsg{ParentPath: "/mnt/a", Name: "x"}, "/mnt/a"},
		{taskMsg{Src: "/mnt/a/f", DstDir: "/mnt/b"}, "/mnt/b"},
		{taskMsg{Path: "/mnt/a/f"}, "/mnt/a"},
		{taskMsg{}, ""},
	}
	for _, c := range cases {
		if got := permissionTargetDir(c.task); got != c.want {
			t.Errorf("permissionTargetDir(%+v) = %q, want %q", c.task, got, c.want)
		}
	}
}
