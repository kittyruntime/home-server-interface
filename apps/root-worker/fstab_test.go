package main

import "testing"

const adminFstab = `# /etc/fstab: static file system information.
UUID=aaaa	/	ext4	defaults	0	1
/dev/sdz1	/srv/manual	ext4	defaults	0	2
`

func TestUpsertFstabEntryAppendsMarkedLine(t *testing.T) {
	entry := "UUID=bbbb\t/mnt/data\text4\tdefaults\t0\t2"
	got, err := upsertFstabEntry(adminFstab, "/mnt/data", "UUID=bbbb", entry)
	if err != nil {
		t.Fatal(err)
	}
	want := adminFstab + "# HSI-managed mount: /mnt/data\n" + entry + "\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	// Repeating the request does not duplicate the entry.
	again, err := upsertFstabEntry(got, "/mnt/data", "UUID=bbbb", entry)
	if err != nil || again != want {
		t.Fatalf("second upsert: err=%v\n%s", err, again)
	}
}

func TestUpsertFstabEntryAdoptsUnmarkedLineForSameSource(t *testing.T) {
	// Entries written by earlier HSI versions have no marker.
	conf := adminFstab + "UUID=bbbb\t/mnt/data\text4\tdefaults\t0\t2\n"
	entry := "UUID=bbbb\t/mnt/data\text4\tnoatime\t0\t2"
	got, err := upsertFstabEntry(conf, "/mnt/data", "UUID=bbbb", entry)
	if err != nil {
		t.Fatal(err)
	}
	if want := adminFstab + "# HSI-managed mount: /mnt/data\n" + entry + "\n"; got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestUpsertFstabEntryRefusesAdminEntryForOtherSource(t *testing.T) {
	entry := "UUID=cccc\t/srv/manual\text4\tdefaults\t0\t2"
	if _, err := upsertFstabEntry(adminFstab, "/srv/manual", "UUID=cccc", entry); err == nil {
		t.Fatal("expected an error for a mount point already used by an entry HSI did not write")
	}
}

func TestRemoveFstabEntryKeepsAdminLines(t *testing.T) {
	entry := "UUID=bbbb\t/mnt/data\text4\tdefaults\t0\t2"
	conf, _ := upsertFstabEntry(adminFstab, "/mnt/data", "UUID=bbbb", entry)
	if got := removeFstabLines(conf, "/mnt/data", "UUID=bbbb", "/dev/vdb1"); got != adminFstab {
		t.Fatalf("got\n%s\nwant\n%s", got, adminFstab)
	}
	// An admin line for a mount point is kept when its source is not the
	// device HSI unmounted.
	if got := removeFstabLines(adminFstab, "/srv/manual", "UUID=zzzz", "/dev/vdc1"); got != adminFstab {
		t.Fatalf("admin line removed:\n%s", got)
	}
	// Legacy unmarked HSI line (same source) is removed.
	legacy := adminFstab + "UUID=bbbb\t/mnt/data\text4\tdefaults\t0\t2\n"
	if got := removeFstabLines(legacy, "/mnt/data", "UUID=bbbb", "/dev/vdb1"); got != adminFstab {
		t.Fatalf("legacy line kept:\n%s", got)
	}
}
