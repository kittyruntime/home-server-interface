package main

import (
	"strings"
	"testing"
)

const twoPools = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:24:01 with 0 errors on Sun Nov 22 00:24:01 2026
config:

	NAME STATE READ WRITE CKSUM
	tank ONLINE 0 0 0
	  /dev/sdb1 ONLINE 0 0 0

errors: No known data errors

  pool: busy
 state: ONLINE
  scan: resilver in progress since Wed Nov 25 10:00:00 2026
	510G resilvered, 42.50% done, 01:15:00 to go
config:

	NAME STATE READ WRITE CKSUM
	busy ONLINE 0 0 0
	  /dev/sdc1 ONLINE 0 0 0

errors: No known data errors
`

func stubScrubHost(t *testing.T, status string) *[]string {
	t.Helper()
	prevA, prevO, prevR := zfsAvailable, hostOutput, runArgv
	t.Cleanup(func() { zfsAvailable, hostOutput, runArgv = prevA, prevO, prevR })
	zfsAvailable = func() bool { return true }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		switch name + " " + args[0] {
		case "zpool list":
			return []byte("tank\t1\t1\t1\t1\t0\tONLINE\nbusy\t2\t1\t1\t1\t0\tONLINE\n"), nil
		case "zpool status":
			return []byte(status), nil
		}
		return nil, nil
	}
	var ran []string
	runArgv = func(argv []string) ([]byte, error) { ran = append(ran, strings.Join(argv, " ")); return nil, nil }
	return &ran
}

func TestZfsScrubTaskSkipsBusyPools(t *testing.T) {
	ran := stubScrubHost(t, twoPools)
	res := runZfsScrubs()
	if strings.Join(*ran, ";") != "zpool scrub tank" {
		t.Errorf("ran %v", *ran)
	}
	if len(res) != 2 || res[0].Device != "tank" || res[0].Status != "started" || res[1].Device != "busy" || res[1].Status != "skipped" {
		t.Errorf("results %+v", res)
	}
}

func TestZfsScrubTaskWithoutZfs(t *testing.T) {
	stubScrubHost(t, twoPools)
	zfsAvailable = func() bool { return false }
	res := runZfsScrubs()
	if len(res) != 1 || res[0].Status != "skipped" {
		t.Errorf("without ZFS the task is skipped, never an error: %+v", res)
	}
}

func TestRefreshScrubResults(t *testing.T) {
	stubScrubHost(t, strings.Replace(twoPools, "with 0 errors", "with 3 errors", 1))
	got := refreshScrubResults([]taskResult{{Device: "tank", Status: "started"}, {Device: "busy", Status: "started"}, {Device: "gone", Status: "started"}})
	if got[0].Status != "failed" || got[1].Status != "running" || got[2].Status != "started" {
		t.Errorf("results %+v", got)
	}
	stubScrubHost(t, twoPools)
	if got := refreshScrubResults([]taskResult{{Device: "tank", Status: "started"}}); got[0].Status != "passed" {
		t.Errorf("a finished clean scrub passed: %+v", got)
	}
}

func TestMaintenanceConfigHasZfsScrub(t *testing.T) {
	cfg := defaultMaintenanceConfig()
	if s := cfg.schedule("zfsScrub"); s.Every != "off" || !s.valid() {
		t.Errorf("zfsScrub defaults to off, valid: %+v", s)
	}
	if !containsString(maintenanceTasks, "zfsScrub") {
		t.Errorf("zfsScrub is a maintenance task")
	}
}
