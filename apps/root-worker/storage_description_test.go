package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func stubDescriptionsDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HSI_STORAGE_DESCRIPTIONS", dir)
	return dir
}

func TestDescriptionName(t *testing.T) {
	for in, want := range map[string]string{"/srv/data": "srv-data", "/mnt/a-b/c": "mnt-a-b-c", "/data": "data"} {
		if got := descriptionName(in); got != want {
			t.Errorf("%s: got %q, want %q", in, got, want)
		}
	}
}

func TestSaveDescriptionCollision(t *testing.T) {
	dir := stubDescriptionsDir(t)
	a := storageDescription{Version: 1, Mount: descMount{Point: "/mnt/a-b"}}
	b := storageDescription{Version: 1, Mount: descMount{Point: "/mnt/a/b"}}
	pa, err := saveDescription(a)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := saveDescription(b)
	if err != nil {
		t.Fatal(err)
	}
	if pa != filepath.Join(dir, "mnt-a-b.yaml") || pb != filepath.Join(dir, "mnt-a-b-2.yaml") {
		t.Fatalf("names: %s %s", pa, pb)
	}
	b.Mount.Options = "defaults"
	if again, _ := saveDescription(b); again != pb {
		t.Fatalf("same mount point keeps its file: %s", again)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 2 {
		t.Fatalf("two files: %v", entries)
	}
}

func TestDescriptionRoundTrip(t *testing.T) {
	stubDescriptionsDir(t)
	d := storageDescription{
		Version:    1,
		Updated:    time.Date(2026, 10, 6, 14, 0, 0, 0, time.UTC),
		Mount:      descMount{Point: "/srv/data", Options: "defaults,nofail"},
		Filesystem: descFS{Type: "ext4", UUID: "5f1c", Label: "data"},
		LVM:        &descLVM{VG: "data", LV: "data"},
		Array:      &descArray{Name: "md0", Level: "raid5", Metadata: "1.2", UUID: "a1:b2", Devices: 3},
		Disks: []descDisk{
			{ByID: "/dev/disk/by-id/ata-A", Serial: "A", WWN: "0x5", Size: 4e12, Role: "active"},
			{ByID: "/dev/disk/by-id/ata-B", Serial: "B", Size: 4e12, Role: "active"},
			{ByID: "/dev/disk/by-id/ata-C-part1", Serial: "C", Size: 4e12, Role: "spare", Partition: 1},
		},
	}
	path, err := saveDescription(d)
	if err != nil {
		t.Fatal(err)
	}
	got, files := loadDescriptions()
	if !reflect.DeepEqual(got["/srv/data"], d) || files["/srv/data"] != path {
		t.Fatalf("round trip:\n%+v\n%+v", got["/srv/data"], d)
	}
	raw, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(raw), "# Written by HSI") || !strings.Contains(string(raw), "guide/storage-descriptions/") {
		t.Fatalf("header: %s", raw)
	}

	plain := storageDescription{Version: 1, Mount: descMount{Point: "/data"}, Filesystem: descFS{Type: "xfs", UUID: "u"}}
	p2, _ := saveDescription(plain)
	raw, _ = os.ReadFile(p2)
	if strings.Contains(string(raw), "lvm:") || strings.Contains(string(raw), "array:") {
		t.Fatalf("no lvm/array keys without them: %s", raw)
	}
}

func TestRemoveDescription(t *testing.T) {
	dir := stubDescriptionsDir(t)
	if _, err := saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/data"}}); err != nil {
		t.Fatal(err)
	}
	if err := removeDescription("/srv/data"); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("removed: %v", entries)
	}
	if err := removeDescription("/srv/none"); err != nil {
		t.Fatalf("absent is fine: %v", err)
	}
}
