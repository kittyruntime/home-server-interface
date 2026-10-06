package main

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

const describeRaid5Detail = `/dev/md127:
           Version : 1.2
        Raid Level : raid5
      Raid Devices : 3
             State : clean
              UUID : a1b2c3d4:11111111:22222222:33333333

    Number   Major   Minor   RaidDevice State
       0       8       16        0      active sync   /dev/sdb
       1       8       32        1      active sync   /dev/sdc
       3       8       48        2      spare rebuilding   /dev/sdd
       4       8       64        -      spare   /dev/sde
       5       8       80        -      faulty   /dev/sdf
`

var describeNow = time.Date(2026, 10, 6, 14, 0, 0, 0, time.UTC)

// stubDescribeHost serves a server with the given fstab, mounts, LVM and
// md detail; disks sdX have serial "S-sdX", size 4e12 and by-id "ata-X_<name>".
func stubDescribeHost(t *testing.T, fstab, mounts string, lvs []lvmLV, pvs []lvmPV, detail string) {
	t.Helper()
	stubConfigFiles(t, fstab, "")
	pm, pl, pp, pr, pd, pb, pi, pdi, ppd := hostProcMounts, hostLvs, hostPvs, hostRealPath, hostMdDetail, hostBlkid, hostByIDLinks, hostDiskIdentity, hostParentDisk
	t.Cleanup(func() {
		hostProcMounts, hostLvs, hostPvs, hostRealPath, hostMdDetail, hostBlkid, hostByIDLinks, hostDiskIdentity, hostParentDisk = pm, pl, pp, pr, pd, pb, pi, pdi, ppd
	})
	hostProcMounts = func() string { return mounts }
	hostLvs = func() []lvmLV { return lvs }
	hostPvs = func() []lvmPV { return pvs }
	hostRealPath = func(p string) string { return strings.Replace(p, "/dev/md/data", "/dev/md127", 1) }
	hostMdDetail = func(string) (string, error) { return detail, nil }
	hostBlkid = func(dev, tag string) string {
		switch tag {
		case "TYPE":
			return "ext4"
		case "LABEL":
			return "data"
		}
		return ""
	}
	hostByIDLinks = func() map[string]string {
		out := map[string]string{"wwn-0x1": "sdb"}
		for _, n := range []string{"sdb", "sdb1", "sdc", "sdd", "sde", "sdf"} {
			out["ata-X_"+n] = n
		}
		return out
	}
	hostDiskIdentity = func(name string) (string, string, int64) {
		wwn := ""
		if name == "sdb" {
			wwn = "0x1"
		}
		return "S-" + name, wwn, 4e12
	}
	hostParentDisk = func(name string) (string, int) {
		if strings.HasSuffix(name, "1") {
			return strings.TrimSuffix(name, "1"), 1
		}
		return name, 0
	}
}

const describeFstab = "UUID=root / ext4 defaults 0 1\n# HSI-managed mount: /srv/data\nUUID=fs-1\t/srv/data\text4\tdefaults,nofail\t0\t2\n"

func TestDescribePlainDisk(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/sdb1 /srv/data ext4 rw 0 0\n", nil, nil, "")
	d, fe := describeVolume("/srv/data", describeNow)
	if fe != nil {
		t.Fatal(fe)
	}
	want := storageDescription{
		Version:    1,
		Updated:    describeNow,
		Mount:      descMount{Point: "/srv/data", Options: "defaults,nofail"},
		Filesystem: descFS{Type: "ext4", UUID: "fs-1", Label: "data"},
		Disks:      []descDisk{{ByID: "/dev/disk/by-id/ata-X_sdb1", Serial: "S-sdb", WWN: "0x1", Size: 4e12, Role: "data", Partition: 1}},
	}
	if !reflect.DeepEqual(d, want) {
		t.Fatalf("got  %+v\nwant %+v", d, want)
	}
}

func TestDescribeLVOnRaid5(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/mapper/data-data /srv/data ext4 rw 0 0\n",
		[]lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}},
		[]lvmPV{{Name: "/dev/md/data", VGName: "data"}}, describeRaid5Detail)
	d, fe := describeVolume("/srv/data", describeNow)
	if fe != nil {
		t.Fatal(fe)
	}
	if d.LVM == nil || d.LVM.VG != "data" || d.LVM.LV != "data" || len(d.LVM.PVs) != 0 {
		t.Fatalf("lvm: %+v", d.LVM)
	}
	wantArray := descArray{Name: "md127", Level: "raid5", Metadata: "1.2", UUID: "a1b2c3d4:11111111:22222222:33333333", Devices: 3}
	if d.Array == nil || *d.Array != wantArray {
		t.Fatalf("array: %+v", d.Array)
	}
	var roles []string
	for _, k := range d.Disks {
		roles = append(roles, k.Serial+":"+k.Role)
	}
	// A rebuilding member is described as active; a faulty one is not described.
	if strings.Join(roles, " ") != "S-sdb:active S-sdc:active S-sdd:active S-sde:spare" {
		t.Fatalf("members: %v", roles)
	}
	if d.Disks[0].ByID != "/dev/disk/by-id/ata-X_sdb" {
		t.Fatalf("by-id: %+v", d.Disks[0])
	}
}

func TestDescribeLVOnDisk(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/mapper/data-data /srv/data ext4 rw 0 0\n",
		[]lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}},
		[]lvmPV{{Name: "/dev/sdc", VGName: "data"}}, "")
	d, fe := describeVolume("/srv/data", describeNow)
	if fe != nil {
		t.Fatal(fe)
	}
	if d.LVM == nil || d.Array != nil || len(d.Disks) != 1 || d.Disks[0].Serial != "S-sdc" || d.Disks[0].Role != "data" {
		t.Fatalf("lv on a disk: %+v", d)
	}
}

func TestDescribeMultiPV(t *testing.T) {
	stubDescribeHost(t, describeFstab, "/dev/mapper/data-data /srv/data ext4 rw 0 0\n",
		[]lvmLV{{Name: "data", VGName: "data", Path: "/dev/data/data"}},
		[]lvmPV{{Name: "/dev/md/data", VGName: "data"}, {Name: "/dev/sdf", VGName: "data"}}, describeRaid5Detail)
	d, fe := describeVolume("/srv/data", describeNow)
	if fe != nil {
		t.Fatal(fe)
	}
	if d.Array != nil || d.LVM == nil || !reflect.DeepEqual(d.LVM.PVs, []string{"md:a1b2c3d4:11111111:22222222:33333333", "/dev/disk/by-id/ata-X_sdf"}) {
		t.Fatalf("multi-PV: %+v %+v", d.Array, d.LVM)
	}
}

func TestDescribeNotMountedOrUnmanaged(t *testing.T) {
	stubDescribeHost(t, describeFstab, "", nil, nil, "")
	if _, fe := describeVolume("/srv/other", describeNow); fe == nil || fe.Code != "ENOENT" {
		t.Fatalf("unmanaged: %+v", fe)
	}
	if _, fe := describeVolume("/srv/data", describeNow); fe == nil || fe.Code != "ENOTMOUNTED" {
		t.Fatalf("not mounted: %+v", fe)
	}
}
