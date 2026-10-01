package main

import (
	"reflect"
	"sort"
	"testing"
)

func TestSystemMountDevices(t *testing.T) {
	mounts := "/dev/mapper/ubuntu--vg-root / ext4 rw 0 0\n" +
		"/dev/nvme0n1p1 /boot/efi vfat rw 0 0\n" +
		"/dev/mmcblk0p1 /boot/firmware vfat rw 0 0\n" +
		"/dev/sdb1 /srv/data ext4 rw 0 0\n" +
		"/dev/loop3 /snap/core/1 squashfs ro 0 0\n"
	names := systemMountDevices(mounts, func() string { return "" })
	sort.Strings(names)
	want := []string{"mmcblk0p1", "nvme0n1p1", "ubuntu--vg-root"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("got %v, want %v", names, want)
	}

	pi := "/dev/root / ext4 rw 0 0\n/dev/mmcblk0p1 /boot/firmware vfat rw 0 0\n"
	names = systemMountDevices(pi, func() string { return "mmcblk0p2" })
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"mmcblk0p1", "mmcblk0p2"}) {
		t.Fatalf("/dev/root must resolve to the real device: %v", names)
	}
}
