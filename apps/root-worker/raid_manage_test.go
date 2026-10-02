package main

import (
	"reflect"
	"testing"
)

func TestParseMdstatMembers(t *testing.T) {
	content := `Personalities : [raid1] [raid5]
md0 : active raid5 sdd[3] sdc[1](F) sdb[0] sde[4](S)
      2093056 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [U_U]
      [==>..................]  recovery = 12.6% (132096/1046528) finish=0.6min speed=22016K/sec

unused devices: <none>
`
	raids := parseMdstat(content)
	if len(raids) != 1 {
		t.Fatalf("got %d arrays", len(raids))
	}
	want := []raidMember{{"sdd", "active"}, {"sdc", "faulty"}, {"sdb", "active"}, {"sde", "spare"}}
	if !reflect.DeepEqual(raids[0].Members, want) {
		t.Errorf("members = %v, want %v", raids[0].Members, want)
	}
	if raids[0].SyncAction != "recovery" || raids[0].ResyncPercent == nil || *raids[0].ResyncPercent != 12.6 {
		t.Errorf("sync = %q %v", raids[0].SyncAction, raids[0].ResyncPercent)
	}
}

func TestReplacementSizeProblem(t *testing.T) {
	if msg := replacementSizeProblem("sdf", 1000, []int64{2000, 1500}); msg == "" {
		t.Error("a device smaller than the smallest member must be refused")
	}
	if msg := replacementSizeProblem("sdf", 1000, []int64{1000, 3000}); msg != "" {
		t.Errorf("same size as the smallest member must be accepted, got %q", msg)
	}
	if msg := replacementSizeProblem("sdf", 1000, nil); msg == "" {
		t.Error("unknown member sizes must be refused")
	}
}

// While an array recovers, the disk it rebuilds onto is listed without (S)
// but is not in sync yet: sysfs says "spare". It is rebuilding, not active.
func TestMarkRebuilding(t *testing.T) {
	ps := hostMdMemberState
	t.Cleanup(func() { hostMdMemberState = ps })
	hostMdMemberState = func(md, dev string) string {
		if md == "md2" && dev == "sde" {
			return "spare"
		}
		return "in_sync"
	}
	raids := []raidArray{
		{Name: "md2", SyncAction: "recovery", Members: []raidMember{{Name: "sde", Role: "active"}, {Name: "sdc", Role: "active"}}},
		{Name: "md1", Members: []raidMember{{Name: "sda", Role: "active"}}},
	}
	markRebuilding(raids)
	if raids[0].Members[0].Role != "rebuilding" || raids[0].Members[1].Role != "active" || raids[1].Members[0].Role != "active" {
		t.Fatalf("roles: %+v %+v", raids[0].Members, raids[1].Members)
	}
}
