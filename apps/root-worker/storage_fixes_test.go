package main

import (
	"strings"
	"testing"
)

// Accept must survive its own preview: the date in the file differs on every
// build of the plan (review finding 1).
func TestAcceptPreviewThenApply(t *testing.T) {
	stubDescriptionsDir(t)
	if _, err := saveDescription(driftDesc()); err != nil {
		t.Fatal(err)
	}
	stubDescribeFn(t, nil)
	in := []byte(`{"mountPoint":"/srv/data"}`)
	prev, fe := previewPlan("storage.accept", in)
	if fe != nil {
		t.Fatal(fe)
	}
	out, fe := applyPlan("storage.accept", in, prev.Fingerprint)
	if fe != nil || !out.OK {
		t.Fatalf("applied: %+v %+v", out, fe)
	}
}

// lsblk prints null for a missing serial or WWN (review finding 3).
func TestParseDiskIdentity(t *testing.T) {
	for _, c := range []struct {
		in, serial, wwn string
		size            int64
	}{
		{`{"blockdevices":[{"serial":"QM00001","wwn":null,"size":34359738368}]}`, "QM00001", "", 34359738368},
		{`{"blockdevices":[{"serial":null,"wwn":"0x5000c500","size":4000}]}`, "", "0x5000c500", 4000},
		{`{"blockdevices":[{"serial":"WD 123 X","wwn":"0x1","size":"4000"}]}`, "WD 123 X", "0x1", 4000},
		{`{"blockdevices":[{"serial":null,"wwn":null,"size":68719476736}]}`, "", "", 68719476736},
	} {
		s, w, n := parseDiskIdentity([]byte(c.in))
		if s != c.serial || w != c.wwn || n != c.size {
			t.Errorf("%s: got %q %q %d", c.in, s, w, n)
		}
	}
}

// Disks without a serial are told apart by WWN, then by their by-id path.
func TestDiskKey(t *testing.T) {
	if k := diskKey(descDisk{Serial: "A", WWN: "0x1", ByID: "/dev/disk/by-id/x"}); k != "A" {
		t.Fatal(k)
	}
	if k := diskKey(descDisk{WWN: "0x1", ByID: "/dev/disk/by-id/x"}); k != "0x1" {
		t.Fatal(k)
	}
	if k := diskKey(descDisk{ByID: "/dev/disk/by-id/virtio-x"}); k != "/dev/disk/by-id/virtio-x" {
		t.Fatal(k)
	}
}

func TestDiffDisksWithoutSerial(t *testing.T) {
	d := driftDesc()
	for i := range d.Disks {
		d.Disks[i].Serial = ""
	}
	l := driftLive()
	l.ArrayMembers = map[string]string{"/dev/disk/by-id/ata-A": "active", "/dev/disk/by-id/ata-C": "active"}
	l.Connected = map[string]bool{"/dev/disk/by-id/ata-A": true, "/dev/disk/by-id/ata-B": false, "/dev/disk/by-id/ata-C": true}
	items := diffDescription(d, l)
	if driftKinds(items) != "disk-missing" || items[0].Text != "Disk /dev/disk/by-id/ata-B is not connected" {
		t.Fatalf("only B is missing: %+v", items)
	}
}

// mdadm --detail --scan names an inactive array INACTIVE-ARRAY (review finding 4).
func TestParseScanInactive(t *testing.T) {
	out := "ARRAY /dev/md1 metadata=1.2 UUID=A\nINACTIVE-ARRAY /dev/md127 metadata=1.2 UUID=U\n"
	if md, active := scanArrayByUUID(out, "U", func(p string) string { return p }); md != "md127" || active {
		t.Fatalf("inactive: %s %v", md, active)
	}
	if md, active := scanArrayByUUID(out, "A", func(p string) string { return p }); md != "md1" || !active {
		t.Fatalf("active: %s %v", md, active)
	}
	if md, _ := scanArrayByUUID(out, "Z", func(p string) string { return p }); md != "" {
		t.Fatal(md)
	}
}

func TestReapplyStopsAnInactiveArrayFirst(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) {
		l.ArrayDev, l.ArrayLevel, l.ArrayMembers, l.VGActive, l.MountedOn, l.FSDevices = "", "", nil, false, "", nil
		l.ArrayInactive = "md127"
	})
	hostMdNames = func() []string { return []string{"md127"} }
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	got := argvs(p)
	if strings.Join(got[0], " ") != "mdadm --stop /dev/md127" || !strings.HasPrefix(strings.Join(got[1], " "), "mdadm --assemble /dev/md127 --uuid=U") {
		t.Fatalf("stop then assemble under the same name: %v", got)
	}
}

// The drift check runs on every alert tick: it reads lsblk and device-mapper,
// never blkid probes or LVM scans that wake sleeping disks (review finding 6).
func TestCollectLiveDoesNotProbeDisks(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/mapper/data-data /srv/data ext4 rw 0 0\n", nil, nil, describeRaid5Detail)
	pd, pa, pv, pe, pu := hostDevsByUUID, hostArrayByUUID, hostLVActive, hostExists, hostUUIDDevices
	t.Cleanup(func() {
		hostDevsByUUID, hostArrayByUUID, hostLVActive, hostExists, hostUUIDDevices = pd, pa, pv, pe, pu
	})
	hostDevsByUUID = func(string) []string { t.Fatal("blkid probe"); return nil }
	hostLVActive = func(string, string) bool { t.Fatal("lvs scan"); return false }
	hostUUIDDevices = func() string { return "/dev/sdb 8f14\n/dev/mapper/data-data fs-1\n/dev/mapper/data-data fs-1\n" }
	hostArrayByUUID = func(string) string { return "md127" }
	hostExists = func(p string) bool { return p == "/dev/mapper/data-data" || strings.HasPrefix(p, "/dev/disk/") }
	l := collectLive(storageDescription{
		Mount: descMount{Point: "/srv/data"}, Filesystem: descFS{UUID: "fs-1"},
		LVM: &descLVM{VG: "data", LV: "data"}, Array: &descArray{UUID: "U"},
	})
	if strings.Join(l.FSDevices, ",") != "/dev/mapper/data-data" || !l.VGActive {
		t.Fatalf("live: %+v", l)
	}
}
