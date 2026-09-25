package main

import (
	"reflect"
	"testing"
)

func TestParseMdstat(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    []raidArray
	}{
		{
			name: "active raid1",
			content: `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      1046528 blocks super 1.2 [2/2] [UU]

unused devices: <none>
`,
			want: []raidArray{
				{Name: "md0", Level: "raid1", State: "active", Devices: []string{"sdb1", "sda1"}, Active: 2, Total: 2},
			},
		},
		{
			name: "active read-only",
			content: `Personalities : [raid1]
md0 : active (read-only) raid1 sdb1[1] sda1[0]
      1046528 blocks super 1.2 [2/2] [UU]
`,
			want: []raidArray{
				{Name: "md0", Level: "raid1", State: "active", Devices: []string{"sdb1", "sda1"}, Active: 2, Total: 2},
			},
		},
		{
			name: "inactive multi-member",
			content: `Personalities : [raid1]
md127 : inactive sdb1[0](S) sdc1[1](S)
      2093056 blocks super 1.2
`,
			want: []raidArray{
				{Name: "md127", Level: "", State: "inactive", Devices: []string{"sdb1", "sdc1"}, Active: 0, Total: 0},
			},
		},
		{
			name: "inactive single-member",
			content: `Personalities : [raid1]
md127 : inactive sdb1[0](S)
      1046528 blocks super 1.2
`,
			want: []raidArray{
				{Name: "md127", Level: "", State: "inactive", Devices: []string{"sdb1"}, Active: 0, Total: 0},
			},
		},
		{
			name: "degraded array",
			content: `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0](F)
      1046528 blocks super 1.2 [2/1] [_U]
`,
			want: []raidArray{
				{Name: "md0", Level: "raid1", State: "active", Devices: []string{"sdb1", "sda1"}, Active: 1, Total: 2},
			},
		},
		{
			name: "nvme member names",
			content: `Personalities : [raid1]
md0 : active raid1 nvme1n1p1[1] nvme0n1p1[0]
      1046528 blocks super 1.2 [2/2] [UU]
`,
			want: []raidArray{
				{Name: "md0", Level: "raid1", State: "active", Devices: []string{"nvme1n1p1", "nvme0n1p1"}, Active: 2, Total: 2},
			},
		},
		{
			name:    "no arrays",
			content: "Personalities : [raid1]\nunused devices: <none>\n",
			want:    []raidArray{},
		},
		{
			name: "mid-rebuild",
			content: `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      1046528 blocks super 1.2 [2/1] [U_]
      [=====>..............]  recovery = 25.5% (267456/1046528) finish=10.2min speed=25000K/sec
`,
			want: []raidArray{
				func() raidArray {
					pct := 25.5
					return raidArray{Name: "md0", Level: "raid1", State: "active", Devices: []string{"sdb1", "sda1"}, Active: 1, Total: 2, ResyncPercent: &pct}
				}(),
			},
		},
		{
			name: "no rebuild in progress",
			content: `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      1046528 blocks super 1.2 [2/2] [UU]
`,
			want: []raidArray{
				{Name: "md0", Level: "raid1", State: "active", Devices: []string{"sdb1", "sda1"}, Active: 2, Total: 2, ResyncPercent: nil},
			},
		},
		{
			name: "two arrays, first has no bracket line (raid0/linear)",
			content: `Personalities : [raid0] [raid1]
md0 : active raid0 sdb1[1] sda1[0]
      2093056 blocks super 1.2 512k chunks

md1 : active raid1 sdd1[1] sdc1[0]
      1046528 blocks super 1.2 [2/1] [U_]
`,
			want: []raidArray{
				{Name: "md0", Level: "raid0", State: "active", Devices: []string{"sdb1", "sda1"}, Active: 0, Total: 0},
				{Name: "md1", Level: "raid1", State: "active", Devices: []string{"sdd1", "sdc1"}, Active: 1, Total: 2},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseMdstat(tc.content)
			// Members and SyncAction are covered by TestParseMdstatMembers.
			for i := range got {
				got[i].Members, got[i].SyncAction = nil, ""
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseMdstat(%q) =\n  %+v\nwant\n  %+v", tc.name, got, tc.want)
			}
		})
	}
}
