package main

import (
	"reflect"
	"testing"
)

const mdDetail = `/dev/md0:
           Version : 1.2
        Raid Level : raid1
      Raid Devices : 2
             State : clean
              Name : hsi:0  (local to host hsi)
              UUID : 3d2c4b1a:8e7f6a5b:1c2d3e4f:5a6b7c8d
            Events : 17

    Number   Major   Minor   RaidDevice State
       0     252       16        0      active sync   /dev/vdb
       1     252       32        1      active sync   /dev/vdc
       -       0        0        2      removed
       3       8       17        -      faulty spare   /dev/sdb1
`

func TestParseMdDetail(t *testing.T) {
	members, uuid := parseMdDetail(mdDetail)
	if want := []string{"/dev/vdb", "/dev/vdc", "/dev/sdb1"}; !reflect.DeepEqual(members, want) {
		t.Errorf("members = %v, want %v", members, want)
	}
	if uuid != "3d2c4b1a:8e7f6a5b:1c2d3e4f:5a6b7c8d" {
		t.Errorf("uuid = %q", uuid)
	}
}

func TestRemoveArrayEntriesDropsLegacyLines(t *testing.T) {
	conf := "MAILADDR root\n" +
		"ARRAY /dev/md0 metadata=1.2 name=hsi:0 UUID=3d2c4b1a:8e7f6a5b:1c2d3e4f:5a6b7c8d\n" +
		"ARRAY /dev/md/other metadata=1.2 UUID=11111111:11111111:11111111:11111111\n"
	got := removeArrayEntries(conf, "md0", "3d2c4b1a:8e7f6a5b:1c2d3e4f:5a6b7c8d")
	want := "MAILADDR root\nARRAY /dev/md/other metadata=1.2 UUID=11111111:11111111:11111111:11111111\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	// Found by UUID even when the device is named differently (md127 after a reboot).
	conf2 := "ARRAY /dev/md127 metadata=1.2 UUID=3d2c4b1a:8e7f6a5b:1c2d3e4f:5a6b7c8d\n"
	if got := removeArrayEntries(conf2, "md0", "3d2c4b1a:8e7f6a5b:1c2d3e4f:5a6b7c8d"); got != "" {
		t.Fatalf("UUID match not removed: %q", got)
	}
}

func TestRemoveFstabSources(t *testing.T) {
	conf := adminFstab +
		"# HSI-managed mount: /mnt/raid\nUUID=cafe\t/mnt/raid\text4\tdefaults\t0\t2\n" +
		"/dev/md0\t/mnt/legacy\text4\tdefaults\t0\t2\n"
	if got := removeFstabSources(conf, "UUID=cafe", "/dev/md0"); got != adminFstab {
		t.Fatalf("got\n%s\nwant\n%s", got, adminFstab)
	}
}
