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
	ps, pr, pv, pf, pm, pa, pu := hostSyncAction, runArgv, hostLVSize, hostVgFree, hostProcMounts, hostArraySize, hostArrayByUUID
	t.Cleanup(func() {
		hostSyncAction, runArgv, hostLVSize, hostVgFree, hostProcMounts, hostArraySize, hostArrayByUUID = ps, pr, pv, pf, pm, pa, pu
	})
	hostArraySize = func(string) int64 { return 96e9 }
	hostArrayByUUID = func(string) string { return "" }
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

func TestAnnouncedEntriesExpire(t *testing.T) {
	old := pendingExpansion{UUID: "fs-1", Phase: "done", Announced: true, FinishedAt: time.Now().Add(-48 * time.Hour)}
	stubExpansions(t, old, pendingExpansion{UUID: "fs-2", Phase: "reshape", Array: "md3"})
	hostSyncAction = func(string) string { return "reshape" }
	finishExpansions(time.Now())
	if got := loadExpansions(); len(got) != 1 || got[0].UUID != "fs-2" {
		t.Fatalf("announced a day ago: dropped: %+v", got)
	}
}

// After a reboot during a reshape the array can read "idle" before the
// reshape resumes: nothing is finished until the array is larger.
func TestFinishExpansionWaitsForTheNewSize(t *testing.T) {
	e := reshaping
	e.ArrayUUID, e.OldSize = "11:22:33:44", 64e9
	ran := stubExpansions(t, e)
	hostSyncAction = func(string) string { return "idle" }
	hostArraySize = func(string) int64 { return 64e9 }
	finishExpansions(time.Now())
	if len(*ran) != 0 || loadExpansions()[0].Phase != "reshape" {
		t.Fatalf("not grown yet: nothing runs: %v", *ran)
	}
	hostArraySize = func(string) int64 { return 96e9 }
	finishExpansions(time.Now())
	if loadExpansions()[0].Phase != "done" {
		t.Fatalf("grown: finished: %+v", loadExpansions()[0])
	}
}

// The array is found by its UUID: its name can change at boot.
func TestFinishExpansionFindsTheArrayByUUID(t *testing.T) {
	e := reshaping
	e.ArrayUUID, e.OldSize, e.Array = "11:22:33:44", 64e9, "md127"
	ran := stubExpansions(t, e)
	hostArrayByUUID = func(uuid string) string { return "md126" }
	hostSyncAction = func(md string) string {
		if md == "md126" {
			return "idle"
		}
		return "reshape"
	}
	hostArraySize = func(md string) int64 {
		if md == "md126" {
			return 96e9
		}
		return 64e9
	}
	finishExpansions(time.Now())
	if (*ran)[0][1] != "/dev/md126" {
		t.Fatalf("pvresize on the renamed array: %v", *ran)
	}
}

// The ext4 check is chosen by the LV's device-mapper path in /proc/mounts.
func TestFinishExpansionSeesTheLVMount(t *testing.T) {
	e := reshaping
	e.MountPoint = "" // unmounted when the expansion started, mounted since
	ran := stubExpansions(t, e)
	hostSyncAction = func(string) string { return "idle" }
	finishExpansions(time.Now())
	for _, a := range *ran {
		if a[0] == "e2fsck" {
			t.Fatalf("no e2fsck on a mounted filesystem: %v", *ran)
		}
	}
}

// Writers of the file do not lose each other's entries.
func TestAddPendingWhileFinishing(t *testing.T) {
	ran := stubExpansions(t, reshaping)
	hostSyncAction = func(string) string { return "idle" }
	runArgv = func(argv []string) ([]byte, error) {
		*ran = append(*ran, argv)
		if argv[0] == "resize2fs" {
			// Another plan records its expansion meanwhile.
			if err := addPendingExpansion(pendingExpansion{UUID: "fs-2", Phase: "reshape"}); err != nil {
				t.Error(err)
			}
		}
		return nil, nil
	}
	finishExpansions(time.Now())
	list := loadExpansions()
	if len(list) != 2 {
		t.Fatalf("both entries kept: %+v", list)
	}
}

// A done entry is announced once, then kept a day so the alert clears.
func TestAckMarksAnnounced(t *testing.T) {
	stubExpansions(t, pendingExpansion{UUID: "fs-1", Phase: "done"})
	if err := ackExpansion("fs-1"); err != nil {
		t.Fatal(err)
	}
	if got := loadExpansions(); len(got) != 1 || !got[0].Announced {
		t.Fatalf("announced, still listed: %+v", got)
	}
}

// e2fsck -p exits 1 when it corrected something: the filesystem is fine.
func TestE2fsckCorrectedIsNotAFailure(t *testing.T) {
	steps, fe := growFsSteps("ext4", "/dev/data/data", "", false)
	if fe != nil {
		t.Fatal(fe)
	}
	pr := runArgv
	t.Cleanup(func() { runArgv = pr })
	runArgv = func(argv []string) ([]byte, error) {
		if argv[0] == "e2fsck" {
			return []byte("data: 11/65536 files"), errors.New("exit status 1")
		}
		return nil, nil
	}
	if _, err := steps[0].run(); err != nil {
		t.Fatalf("exit 1 is fine: %v", err)
	}
	runArgv = func([]string) ([]byte, error) { return []byte("UNEXPECTED INCONSISTENCY"), errors.New("exit status 4") }
	if _, err := steps[0].run(); err == nil {
		t.Fatal("exit 4 is a failure")
	}
}
