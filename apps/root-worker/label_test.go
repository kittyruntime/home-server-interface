package main

import "testing"

func TestConvertDevLabel(t *testing.T) {
	d := convertDev(lsblkRaw{Name: "sdb1", Type: "part", Label: "media"}, map[string]bool{}, false)
	if d.Label != "media" {
		t.Fatalf("label: got %q", d.Label)
	}
	if convertDev(lsblkRaw{Name: "sdc", Type: "disk"}, map[string]bool{}, false).Label != "" {
		t.Fatal("no label must stay empty")
	}
}
