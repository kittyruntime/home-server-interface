package main

import (
	"errors"
	"strings"
	"testing"
)

const fstrimOut = "/srv/data: 1.2 GiB (1288490188 bytes) trimmed on /dev/mapper/data-data\n" +
	"fstrim: /mnt/usb: the discard operation is not supported\n" +
	"/: 0 B (0 bytes) trimmed on /dev/nvme0n1p2\n" +
	"fstrim: /srv/bad: FITRIM ioctl failed: Input/output error\n"

func TestParseFstrim(t *testing.T) {
	r := parseFstrim(fstrimOut)
	got := []string{}
	for _, x := range r {
		got = append(got, x.Device+"|"+x.Status+"|"+x.Message)
	}
	want := []string{
		"/srv/data|passed|1.2 GiB trimmed",
		"/mnt/usb|skipped|the discard operation is not supported",
		"/|passed|0 B trimmed",
		"/srv/bad|error|FITRIM ioctl failed: Input/output error",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s", strings.Join(got, "\n"))
	}
}

func TestRunTrim(t *testing.T) {
	prevR, prevL, prevA, prevO := runArgv, trimLookPath, zfsAvailable, hostOutput
	t.Cleanup(func() { runArgv, trimLookPath, zfsAvailable, hostOutput = prevR, prevL, prevA, prevO })
	trimLookPath = func(string) (string, error) { return "/usr/sbin/fstrim", nil }
	zfsAvailable = func() bool { return true }
	hostOutput = func(name string, args ...string) ([]byte, error) {
		if name == "zpool" && args[0] == "list" {
			return []byte("tank\t1\t1\t1\t1\t0\tONLINE\nhdd\t2\t1\t1\t1\t0\tONLINE\n"), nil
		}
		return nil, nil
	}
	var ran []string
	runArgv = func(argv []string) ([]byte, error) {
		ran = append(ran, strings.Join(argv, " "))
		switch strings.Join(argv, " ") {
		case "fstrim --all --verbose":
			return []byte(fstrimOut), errors.New("exit status 64")
		case "zpool trim hdd":
			return []byte("cannot trim: no devices in pool support trim operations"), errors.New("exit status 1")
		}
		return nil, nil
	}
	res := runTrim()
	if strings.Join(ran, ";") != "fstrim --all --verbose;zpool trim tank;zpool trim hdd" {
		t.Errorf("ran %v", ran)
	}
	last := res[len(res)-2:]
	if last[0].Device != "tank" || last[0].Status != "started" || last[1].Device != "hdd" || last[1].Status != "skipped" {
		t.Errorf("pools: %+v", last)
	}
	// Without fstrim nor ZFS: skipped, never an error.
	trimLookPath = func(string) (string, error) { return "", errors.New("not found") }
	zfsAvailable = func() bool { return false }
	if r := runTrim(); len(r) != 1 || r[0].Status != "skipped" {
		t.Errorf("%+v", r)
	}
}

func TestMaintenanceConfigHasTrim(t *testing.T) {
	if d := defaultMaintenanceConfig().Trim; d.Every != "off" {
		t.Errorf("TRIM is off by default (the distro's fstrim.timer usually runs it): %+v", d)
	}
	prev := maintenanceConfig{Trim: taskSchedule{Every: "weekly", Weekday: 6, Day: 1, Hour: 4}}
	next := withKeptSchedules(maintenanceConfig{}, prev)
	if next.Trim.Every != "weekly" {
		t.Errorf("a client without the trim field keeps the saved one: %+v", next.Trim)
	}
	found := false
	for _, x := range maintenanceTasks {
		found = found || x == "trim"
	}
	if !found {
		t.Error("trim is a maintenance task")
	}
}
