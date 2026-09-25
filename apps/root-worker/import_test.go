package main

import (
	"reflect"
	"testing"
)

func TestParseExamineScan(t *testing.T) {
	out := `ARRAY /dev/md/0  level=raid1 metadata=1.2 num-devices=2 UUID=aaaa:bbbb:cccc:dddd name=oldhost:0
   devices=/dev/vdb,/dev/vdc
ARRAY /dev/md/data  level=raid5 metadata=1.2 num-devices=3 UUID=1111:2222:3333:4444 name=nas:data
   devices=/dev/sdb1,/dev/sdc1
`
	got := parseExamineScan(out)
	want := []foundArray{
		{Device: "/dev/md/0", Level: "raid1", UUID: "aaaa:bbbb:cccc:dddd", Name: "oldhost:0", Expected: 2, Members: []string{"/dev/vdb", "/dev/vdc"}},
		{Device: "/dev/md/data", Level: "raid5", UUID: "1111:2222:3333:4444", Name: "nas:data", Expected: 3, Members: []string{"/dev/sdb1", "/dev/sdc1"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestUnassembledArrays(t *testing.T) {
	found := []foundArray{
		{UUID: "aaaa", Expected: 2, Members: []string{"/dev/vdb", "/dev/vdc"}},
		{UUID: "bbbb", Expected: 3, Members: []string{"/dev/sdb1", "/dev/sdc1"}},
	}
	got := unassembledArrays(found, map[string]bool{"aaaa": true})
	if len(got) != 1 || got[0].UUID != "bbbb" || got[0].Missing != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseInactiveVGs(t *testing.T) {
	lvs := "  data:media:\n  data:backup:\n  vg1:lv0:a\n  old:x:\n"
	got := parseInactiveVGs(lvs)
	want := []foundVG{{Name: "data", LVs: []string{"media", "backup"}}, {Name: "old", LVs: []string{"x"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
