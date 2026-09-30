package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Stable names from /dev/disk/by-id: kernel names (sdb) can change between
// boots, these do not. One name per device, the most readable one.

// hostByIDLinks maps each /dev/disk/by-id link name to the kernel name it
// points to. Tests replace it.
var hostByIDLinks = func() map[string]string {
	out := map[string]string{}
	entries, err := os.ReadDir("/dev/disk/by-id")
	if err != nil {
		return out
	}
	for _, e := range entries {
		target, err := os.Readlink(filepath.Join("/dev/disk/by-id", e.Name()))
		if err == nil {
			out[e.Name()] = filepath.Base(target)
		}
	}
	return out
}

// byIDRank orders link kinds: bus names carry the model and serial, wwn and
// eui are opaque, scsi- names duplicate ata- ones on SATA disks.
func byIDRank(name string) int {
	for i, p := range []string{"ata-", "nvme-", "usb-", "mmc-", "scsi-", "md-", "dm-", "lvm-"} {
		if strings.HasPrefix(name, p) && !strings.HasPrefix(name, "nvme-eui.") && !strings.HasPrefix(name, "nvme-nvme.") {
			return i
		}
	}
	return 100
}

func preferredByID(links map[string]string) map[string]string {
	best := map[string]string{}
	for name, dev := range links {
		cur, ok := best[dev]
		if !ok || byIDRank(name) < byIDRank(cur) ||
			(byIDRank(name) == byIDRank(cur) && (len(name) < len(cur) || (len(name) == len(cur) && name < cur))) {
			best[dev] = name
		}
	}
	return best
}

func assignByID(devs []BlockDev, names map[string]string) {
	for i := range devs {
		devs[i].ByID = names[devs[i].Name]
		assignByID(devs[i].Children, names)
	}
}
