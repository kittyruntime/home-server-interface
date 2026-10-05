package main

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func stubExpansions(t *testing.T, entries ...pendingExpansion) *[][]string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HSI_EXPANSIONS", dir+"/expansions.json")
	t.Setenv("HSI_EXPANSIONS_LOCK", dir+"/lock")
	if err := saveExpansions(entries); err != nil {
		t.Fatal(err)
	}
	ps, pr, pv, pf, pm := hostSyncAction, runArgv, hostLVSize, hostVgFree, hostProcMounts
	t.Cleanup(func() { hostSyncAction, runArgv, hostLVSize, hostVgFree, hostProcMounts = ps, pr, pv, pf, pm })
	hostLVSize = func(string) int64 { return 96e9 }
	hostVgFree = func(string) int64 { return 32e9 } // what pvresize made available
	hostProcMounts = func() string { return "/dev/mapper/data-data /srv/data ext4 rw 0 0\n" }
	ran := &[][]string{}
	runArgv = func(argv []string) ([]byte, error) { *ran = append(*ran, argv); return nil, nil }
	return ran
}

var reshaping = pendingExpansion{UUID: "fs-1", Array: "md3", VG: "data", LV: "/dev/data/data", FSType: "ext4", MountPoint: "/srv/data", Phase: "reshape"}

func TestFinishExpansionWaitsForTheReshape(t *testing.T) {
	ran := stubExpansions(t, reshaping)
	hostSyncAction = func(string) string { return "reshape" }
	finishExpansions(time.Now())
	if len(*ran) != 0 || loadExpansions()[0].Phase != "reshape" {
		t.Fatalf("nothing runs during the reshape: %v %+v", *ran, loadExpansions())
	}
}

func TestFinishExpansionWhenIdle(t *testing.T) {
	ran := stubExpansions(t, reshaping)
	hostSyncAction = func(string) string { return "idle" }
	finishExpansions(time.Now())
	want := [][]string{{"pvresize", "/dev/md3"}, {"lvextend", "-l", "+100%FREE", "/dev/data/data"}, {"resize2fs", "/dev/data/data"}}
	if !reflect.DeepEqual(*ran, want) {
		t.Fatalf("finishing steps: %v", *ran)
	}
	got := loadExpansions()[0]
	if got.Phase != "done" || got.NewSize != 96e9 {
		t.Fatalf("done with the new size: %+v", got)
	}
}

func TestFinishExpansionFailureIsKept(t *testing.T) {
	ran := stubExpansions(t, reshaping)
	hostSyncAction = func(string) string { return "idle" }
	runArgv = func(argv []string) ([]byte, error) {
		*ran = append(*ran, argv)
		if argv[0] == "resize2fs" {
			return []byte("resize2fs: Device or resource busy"), errors.New("exit status 1")
		}
		return nil, nil
	}
	finishExpansions(time.Now())
	got := loadExpansions()[0]
	if got.Phase != "failed" || !strings.Contains(got.Error, "busy") {
		t.Fatalf("failure kept with its error: %+v", got)
	}
	// Retry: back to the finishing steps only.
	if err := retryExpansion("fs-1"); err != nil {
		t.Fatal(err)
	}
	if got := loadExpansions()[0]; got.Phase != "reshape" || got.Error != "" {
		t.Fatalf("retry: %+v", got)
	}
}

func TestFinishExpansionsAreSerialised(t *testing.T) {
	ran := stubExpansions(t, reshaping)
	hostSyncAction = func(string) string { return "idle" }
	lock, err := os.OpenFile(os.Getenv("HSI_EXPANSIONS_LOCK"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := flockExclusive(lock); err != nil {
		t.Fatal(err)
	}
	finishExpansions(time.Now())
	if len(*ran) != 0 {
		t.Fatalf("another finisher holds the lock: nothing runs: %v", *ran)
	}
}

func TestAckExpansionRemovesDone(t *testing.T) {
	stubExpansions(t, pendingExpansion{UUID: "fs-1", Phase: "done"}, pendingExpansion{UUID: "fs-2", Phase: "reshape"})
	if err := ackExpansion("fs-1"); err != nil {
		t.Fatal(err)
	}
	if got := loadExpansions(); len(got) != 1 || got[0].UUID != "fs-2" {
		t.Fatalf("ack: %+v", got)
	}
}
