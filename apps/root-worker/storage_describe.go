package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Building a storage description (#37) from the live server: the marked
// fstab entry, what is mounted there, and the stack under it.

var (
	// hostDiskIdentity returns a whole disk's serial, WWN and size.
	hostDiskIdentity = func(name string) (serial, wwn string, size int64) {
		out, _ := hostOutput("lsblk", "-J", "-d", "-b", "-o", "SERIAL,WWN,SIZE", "/dev/"+name)
		return parseDiskIdentity(out)
	}
	// hostParentDisk returns the disk a partition is on and its number; a
	// whole disk is its own parent, number 0.
	hostParentDisk = func(name string) (string, int) {
		raw, err := os.ReadFile("/sys/class/block/" + name + "/partition")
		if err != nil {
			return name, 0
		}
		n, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
		// -d: the device alone, not its holders (an md or LVM on it).
		out, _ := hostOutput("lsblk", "-dno", "PKNAME", "/dev/"+name)
		if p := strings.TrimSpace(string(out)); p != "" {
			return p, n
		}
		return name, n
	}
)

// parseDiskIdentity reads "lsblk -J -d -b -o SERIAL,WWN,SIZE": a missing
// serial or WWN is null, and a serial may contain spaces.
func parseDiskIdentity(raw []byte) (serial, wwn string, size int64) {
	var out struct {
		Blockdevices []struct {
			Serial *string         `json:"serial"`
			WWN    *string         `json:"wwn"`
			Size   json.RawMessage `json:"size"`
		} `json:"blockdevices"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Blockdevices) == 0 {
		return "", "", 0
	}
	b := out.Blockdevices[0]
	if b.Serial != nil {
		serial = strings.TrimSpace(*b.Serial)
	}
	if b.WWN != nil {
		wwn = strings.TrimSpace(*b.WWN)
	}
	size, _ = strconv.ParseInt(strings.Trim(string(b.Size), `"`), 10, 64)
	return serial, wwn, size
}

// diskKey identifies a described disk: its serial, else its WWN, else its
// by-id path (virtual disks often have neither).
func diskKey(d descDisk) string {
	switch {
	case d.Serial != "":
		return d.Serial
	case d.WWN != "":
		return d.WWN
	}
	return d.ByID
}

// hostByPathLinks maps each /dev/disk/by-path link to the kernel name it
// points to.
var hostByPathLinks = func() map[string]string {
	out := map[string]string{}
	entries, _ := os.ReadDir("/dev/disk/by-path")
	for _, e := range entries {
		if target, err := os.Readlink(filepath.Join("/dev/disk/by-path", e.Name())); err == nil {
			out[e.Name()] = filepath.Base(target)
		}
	}
	return out
}

func byPathFor(name string) string {
	best := ""
	for link, dev := range hostByPathLinks() {
		if dev == name && (best == "" || len(link) < len(best) || (len(link) == len(best) && link < best)) {
			best = link
		}
	}
	return best
}

type mdMember struct{ Dev, Role string }

// mdMembers reads the member table of "mdadm --detail": active and
// rebuilding members are active, spares are spare, faulty ones are left out.
func mdMembers(detail string) []mdMember {
	var out []mdMember
	inTable := false
	for _, l := range strings.Split(detail, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "Number") && strings.Contains(t, "RaidDevice") {
			inTable = true
			continue
		}
		f := strings.Fields(t)
		if !inTable || len(f) < 2 || !strings.HasPrefix(f[len(f)-1], "/dev/") {
			continue
		}
		state := strings.Join(f[4:len(f)-1], " ")
		dev := filepath.Base(f[len(f)-1])
		switch {
		case strings.Contains(state, "faulty"):
		case strings.Contains(state, "rebuilding"), strings.Contains(state, "active"):
			out = append(out, mdMember{dev, "active"})
		case strings.Contains(state, "spare"):
			out = append(out, mdMember{dev, "spare"})
		}
	}
	return out
}

// mdDetailField returns a "Key : value" field of "mdadm --detail".
func mdDetailField(detail, key string) string {
	for _, l := range strings.Split(detail, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(l), ":"); ok && strings.TrimSpace(k) == key {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func describeDisk(name, role string, byID map[string]string) descDisk {
	disk, part := hostParentDisk(name)
	serial, wwn, size := hostDiskIdentity(disk)
	d := descDisk{Serial: serial, WWN: wwn, Size: size, Role: role, Partition: part}
	switch {
	case byID[name] != "":
		d.ByID = "/dev/disk/by-id/" + byID[name]
	case byPathFor(name) != "":
		// No by-id link (some virtual disks): the bus path does not move to
		// another disk at reboot the way a kernel name can.
		d.ByID = "/dev/disk/by-path/" + byPathFor(name)
	default:
		d.ByID = "/dev/" + name
	}
	return d
}

// describeArray describes the md array dev (a kernel name such as md127).
func describeArray(md string, byID map[string]string) (*descArray, []descDisk) {
	detail, _ := hostMdDetail("/dev/" + md)
	_, uuid := parseMdDetail(detail)
	devices, _ := strconv.Atoi(mdDetailField(detail, "Raid Devices"))
	a := &descArray{Name: md, Level: mdDetailField(detail, "Raid Level"), Metadata: mdDetailField(detail, "Version"), UUID: uuid, Devices: devices}
	var disks []descDisk
	for _, m := range mdMembers(detail) {
		disks = append(disks, describeDisk(m.Dev, m.Role, byID))
	}
	return a, disks
}

// describeVolume describes the HSI-managed volume at mountPoint from the
// server. It must be mounted: an unmounted volume cannot be read back.
func describeVolume(mountPoint string, now time.Time) (storageDescription, *fsError) {
	var entry *volumeEntry
	for _, v := range hsiVolumes(readFstab()) {
		if v.MountPoint == mountPoint {
			v := v
			entry = &v
		}
	}
	if entry == nil {
		return storageDescription{}, &fsError{Code: "ENOENT", Message: "no HSI-managed volume at " + mountPoint}
	}
	dev := ""
	for _, l := range strings.Split(hostProcMounts(), "\n") {
		if f := strings.Fields(l); len(f) >= 2 && f[1] == mountPoint {
			dev = f[0]
		}
	}
	if dev == "" {
		return storageDescription{}, &fsError{Code: "ENOTMOUNTED", Message: mountPoint + " is not mounted"}
	}
	d := storageDescription{
		Version:    1,
		Updated:    now.UTC(),
		Mount:      descMount{Point: mountPoint, Options: entry.Options},
		Filesystem: descFS{Type: hostBlkid(dev, "TYPE"), UUID: entry.UUID, Label: hostBlkid(dev, "LABEL")},
	}
	byID := preferredByID(hostByIDLinks())

	var lv *lvmLV
	for _, l := range hostLvs() {
		if l.Path == dev || lvDmPath(l.VGName, l.Name) == dev {
			l := l
			lv = &l
		}
	}
	under := []string{filepath.Base(hostRealPath(dev))} // what the filesystem sits on
	if lv != nil {
		d.LVM = &descLVM{VG: lv.VGName, LV: lv.Name}
		under = nil
		for _, p := range hostPvs() {
			if p.VGName == lv.VGName {
				under = append(under, filepath.Base(hostRealPath(p.Name)))
			}
		}
	}
	if len(under) == 1 {
		if reMdDev.MatchString(under[0]) {
			d.Array, d.Disks = describeArray(under[0], byID)
		} else {
			d.Disks = []descDisk{describeDisk(under[0], "data", byID)}
		}
		return d, nil
	}
	// A volume group over several physical volumes: each one by its by-id
	// path, or md:<uuid> for an array.
	for _, n := range under {
		if reMdDev.MatchString(n) {
			a, _ := describeArray(n, byID)
			d.LVM.PVs = append(d.LVM.PVs, "md:"+a.UUID)
			continue
		}
		disk := describeDisk(n, "data", byID)
		d.LVM.PVs = append(d.LVM.PVs, disk.ByID)
		d.Disks = append(d.Disks, disk)
	}
	return d, nil
}
