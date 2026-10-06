package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// driftDesc is a RAID 5 + LVM volume with three active members.
func driftDesc() storageDescription {
	return storageDescription{
		Version:    1,
		Mount:      descMount{Point: "/srv/data", Options: "defaults,nofail"},
		Filesystem: descFS{Type: "ext4", UUID: "fs-1"},
		LVM:        &descLVM{VG: "data", LV: "data"},
		Array:      &descArray{Name: "md0", Level: "raid5", Metadata: "1.2", UUID: "U", Devices: 3},
		Disks: []descDisk{
			{ByID: "/dev/disk/by-id/ata-A", Serial: "A", Role: "active"},
			{ByID: "/dev/disk/by-id/ata-B", Serial: "B", Role: "active"},
			{ByID: "/dev/disk/by-id/ata-C", Serial: "C", Role: "active"},
		},
	}
}

// driftLive is the server matching driftDesc, the array running as md127.
func driftLive() liveVolume {
	return liveVolume{
		MountedOn:         "/srv/data",
		FSDevices:         []string{"/dev/mapper/data-data"},
		FstabPresent:      true,
		FstabUUID:         "fs-1",
		FstabOptions:      "defaults,nofail",
		ArrayDev:          "md127",
		ArrayLevel:        "raid5",
		ArrayMembers:      map[string]string{"A": "active", "B": "active", "C": "active"},
		MdadmConfHasArray: true,
		VGActive:          true,
		Connected:         map[string]bool{"A": true, "B": true, "C": true},
	}
}

func driftKinds(items []driftItem) string {
	var k []string
	for _, i := range items {
		k = append(k, i.Kind)
	}
	return strings.Join(k, ",")
}

func checkDrift(t *testing.T, edit func(*liveVolume), wantKinds string, wantText string) {
	t.Helper()
	l := driftLive()
	edit(&l)
	items := diffDescription(driftDesc(), l)
	if driftKinds(items) != wantKinds {
		t.Fatalf("kinds: got %q, want %q (%+v)", driftKinds(items), wantKinds, items)
	}
	if wantText != "" && items[0].Text != wantText {
		t.Fatalf("text: got %q, want %q", items[0].Text, wantText)
	}
}

func TestDiffClean(t *testing.T) { checkDrift(t, func(*liveVolume) {}, "", "") }

// Described as md0, running as md127 after a reboot: the same array.
func TestDiffMatchesArrayByUUID(t *testing.T) { checkDrift(t, func(*liveVolume) {}, "", "") }

func TestDiffNotMounted(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.MountedOn = "" }, "not-mounted", "/srv/data is not mounted")
}

func TestDiffMountedElsewhere(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.MountedOn = "/mnt/x" }, "mounted-elsewhere",
		"The filesystem is mounted on /mnt/x instead of /srv/data")
}

func TestDiffFSChanged(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.MountedOn, l.MountPointUUID = "", "fs-9" }, "fs-changed",
		"The filesystem on /srv/data is no longer fs-1 (now fs-9)")
}

func TestDiffFstabMissing(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.FstabPresent = false }, "fstab-missing", "The fstab entry for /srv/data is missing")
}

func TestDiffFstabChanged(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.FstabOptions = "defaults" }, "fstab-changed",
		"The fstab entry for /srv/data changed (options defaults instead of defaults,nofail)")
}

func TestDiffArrayStopped(t *testing.T) {
	checkDrift(t, func(l *liveVolume) {
		l.ArrayDev, l.ArrayLevel, l.ArrayMembers, l.VGActive, l.MountedOn = "", "", nil, false, ""
	}, "not-mounted,array-stopped", "")
	l := driftLive()
	l.ArrayDev, l.ArrayMembers = "", nil
	if items := diffDescription(driftDesc(), l); items[0].Text != "Array U (md0) is not running" {
		t.Fatalf("text: %+v", items)
	}
}

func TestDiffArrayLevel(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.ArrayLevel = "raid6" }, "array-level", "md127 is raid6, described as raid5")
}

func TestDiffMdadmConfMissing(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.MdadmConfHasArray = false }, "mdadm-conf-missing", "mdadm.conf has no ARRAY line for md127")
}

func TestDiffDiskMissing(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { delete(l.ArrayMembers, "B"); l.Connected["B"] = false }, "disk-missing", "Disk B is not connected")
}

func TestDiffDiskNotMember(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { delete(l.ArrayMembers, "B") }, "disk-not-member", "Disk B is no longer in md127")
}

func TestDiffDiskNewMember(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.ArrayMembers["D"] = "active" }, "disk-new-member", "Disk D is in md127 but not in the description")
}

func TestDiffVGInactive(t *testing.T) {
	checkDrift(t, func(l *liveVolume) { l.VGActive, l.MountedOn = false, "" }, "not-mounted,vg-inactive", "")
}

func TestDescriptionStatusesNATS(t *testing.T) {
	stubDescriptionsDir(t)
	if _, err := saveDescription(driftDesc()); err != nil {
		t.Fatal(err)
	}
	prev := collectLiveFn
	t.Cleanup(func() { collectLiveFn = prev })
	collectLiveFn = func(storageDescription) liveVolume { l := driftLive(); l.FstabPresent = false; return l }
	raw, _ := json.Marshal(map[string]any{"descriptions": descriptionStatuses()})
	if !strings.Contains(string(raw), `"kind":"fstab-missing"`) || !strings.Contains(string(raw), `"mountPoint":"/srv/data"`) {
		t.Fatalf("reply: %s", raw)
	}
}

func TestCollectLive(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/mapper/data-data /srv/data ext4 rw 0 0\n", nil, nil, describeRaid5Detail)
	stubConfigFiles(t, describeFstab, "# HSI-managed array: md0\nARRAY /dev/md0 metadata=1.2 UUID=a1b2c3d4:11111111:22222222:33333333\n")
	pd, pa, pv, pe := hostDevsByUUID, hostArrayByUUID, hostLVActive, hostExists
	t.Cleanup(func() { hostDevsByUUID, hostArrayByUUID, hostLVActive, hostExists = pd, pa, pv, pe })
	hostDevsByUUID = func(string) []string { return []string{"/dev/mapper/data-data"} }
	hostArrayByUUID = func(string) string { return "md127" }
	hostLVActive = func(string, string) bool { return true }
	hostExists = func(p string) bool { return !strings.HasSuffix(p, "ata-X_sdz") }
	d := storageDescription{
		Mount:      descMount{Point: "/srv/data", Options: "defaults,nofail"},
		Filesystem: descFS{UUID: "fs-1"},
		LVM:        &descLVM{VG: "data", LV: "data"},
		Array:      &descArray{Name: "md0", Level: "raid5", UUID: "a1b2c3d4:11111111:22222222:33333333"},
		Disks:      []descDisk{{ByID: "/dev/disk/by-id/ata-X_sdz", Serial: "S-sdz"}},
	}
	l := collectLive(d)
	if l.MountedOn != "/srv/data" || !l.FstabPresent || l.FstabUUID != "fs-1" || !l.MdadmConfHasArray || l.ArrayDev != "md127" ||
		l.ArrayLevel != "raid5" || l.ArrayMembers["S-sdb"] != "active" || l.ArrayMembers["S-sde"] != "spare" || !l.VGActive || l.Connected["S-sdz"] {
		t.Fatalf("live: %+v", l)
	}
}
