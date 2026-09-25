package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseLsblkPairs(t *testing.T) {
	out := `NAME="vdb" FSTYPE="linux_raid_member" MOUNTPOINT=""
NAME="md0" FSTYPE="LVM2_member" MOUNTPOINT=""
NAME="vg1-lv0" FSTYPE="ext4" MOUNTPOINT="/mnt/vg1-lv0"
`
	want := []blkNode{
		{Name: "vdb", FsType: "linux_raid_member"},
		{Name: "md0", FsType: "LVM2_member"},
		{Name: "vg1-lv0", FsType: "ext4", MountPoint: "/mnt/vg1-lv0"},
	}
	if got := parseLsblkPairs(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseLsblkPairs() = %#v, want %#v", got, want)
	}
}

func TestMemberReason(t *testing.T) {
	cases := []struct {
		name  string
		nodes []blkNode
		want  string // substring, "" = not a member
	}{
		{"free disk", []blkNode{{Name: "vdc"}}, ""},
		{"whole-disk raid member", []blkNode{{Name: "vdb", FsType: "linux_raid_member"}, {Name: "md0"}}, "vdb is a member of a RAID array"},
		{"partition is a PV", []blkNode{{Name: "sdb"}, {Name: "sdb1", FsType: "LVM2_member"}}, "sdb1 is an LVM physical volume"},
		{"plain filesystem", []blkNode{{Name: "sdc1", FsType: "ext4"}}, ""},
	}
	for _, c := range cases {
		got := memberReason(c.nodes)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: memberReason() = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestClaimBlockReason(t *testing.T) {
	cases := []struct {
		name  string
		nodes []blkNode
		want  string // substring, "" = claimable
	}{
		{"blank disk", []blkNode{{Name: "vdc"}}, ""},
		{"blank partition", []blkNode{{Name: "vdc1"}}, ""},
		{"assembled array as PV", []blkNode{{Name: "md0"}}, ""},
		{"raid member", []blkNode{{Name: "vdb", FsType: "linux_raid_member"}}, "member of a RAID array"},
		{"lvm pv", []blkNode{{Name: "vdd", FsType: "LVM2_member"}}, "LVM physical volume"},
		{"existing filesystem", []blkNode{{Name: "vde", FsType: "ext4"}}, "vde contains a ext4 filesystem"},
		{"mounted", []blkNode{{Name: "vdf", MountPoint: "/mnt/x"}}, "vdf is mounted on /mnt/x"},
		{"disk with partitions", []blkNode{{Name: "vdg"}, {Name: "vdg1"}}, "vdg has partitions"},
		{"partition holding a filesystem", []blkNode{{Name: "vdh"}, {Name: "vdh1", FsType: "xfs"}}, "vdh1 contains a xfs filesystem"},
		{"no data", nil, "could not inspect"},
	}
	for _, c := range cases {
		got := claimBlockReason(c.nodes)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: claimBlockReason() = %q, want %q", c.name, got, c.want)
		}
	}
}
