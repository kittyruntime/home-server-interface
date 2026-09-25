package main

import "testing"

func TestIsFreshVolumeRoot(t *testing.T) {
	cases := []struct {
		entries []string
		want    bool
	}{
		{nil, true},
		{[]string{"lost+found"}, true},
		{[]string{"lost+found", "photos"}, false},
		{[]string{".snapshots"}, false},
	}
	for _, c := range cases {
		if got := isFreshVolumeRoot(c.entries); got != c.want {
			t.Errorf("isFreshVolumeRoot(%v) = %v, want %v", c.entries, got, c.want)
		}
	}
}
