package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// ── Drift from storage descriptions (#37) ────────────────────────────────────
// What differs between a volume's description and the server, in plain
// sentences. HSI shows it and never corrects it on its own.

type driftItem struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
	Role string `json:"role,omitempty"` // a missing disk's role: active or spare
}

// liveVolume is what the server shows for one description.
type liveVolume struct {
	MountedOn         string   // where the described filesystem is mounted, "" if nowhere
	MountPointUUID    string   // UUID of another filesystem mounted on the described mount point
	FSDevices         []string // devices carrying the described filesystem UUID
	FstabPresent      bool     // HSI's marked entry for the mount point
	FstabUUID         string
	FstabOptions      string
	ArrayDev          string            // the running array with the described UUID (md127), "" if stopped
	ArrayInactive     string            // an inactive array holding the described UUID's members (md127)
	ArrayLevel        string            // its level
	ArrayMembers      map[string]string // its members: disk key (diskKey) -> active/spare
	MdadmConfHasArray bool              // an ARRAY line for the described UUID
	VGActive          bool
	Connected         map[string]bool // described disks by key (diskKey): connected or not
}

var (
	// hostLVActive tells whether an LV is active. Only plans use it: the
	// periodic drift check reads device-mapper instead, as an LVM scan reads
	// every disk and would wake sleeping ones.
	hostLVActive = func(vg, lv string) bool {
		out, _ := hostOutput("lvs", "--noheadings", "-o", "lv_active", vg+"/"+lv)
		return strings.TrimSpace(string(out)) == "active"
	}
	// hostUUIDDevices lists "<path> <uuid>" lines from the udev database
	// (lsblk), without probing the disks the way blkid does.
	hostUUIDDevices = func() string {
		out, _ := hostOutput("lsblk", "-rno", "PATH,UUID")
		return string(out)
	}
	hostInactiveArrayByUUID = func(uuid string) string {
		out, _ := hostOutput("mdadm", "--detail", "--scan")
		if md, active := scanArrayByUUID(string(out), uuid, hostRealPath); !active {
			return md
		}
		return ""
	}
	// hostDiskKeys lists the identity keys (serial, WWN) of the disks on the
	// server, from the udev database.
	hostDiskKeys = func() map[string]bool {
		out, _ := hostOutput("lsblk", "-J", "-d", "-o", "SERIAL,WWN")
		return parseDiskKeys(out)
	}
	collectLiveFn = collectLive
)

func parseDiskKeys(raw []byte) map[string]bool {
	var out struct {
		Blockdevices []struct {
			Serial *string `json:"serial"`
			WWN    *string `json:"wwn"`
		} `json:"blockdevices"`
	}
	keys := map[string]bool{}
	if json.Unmarshal(raw, &out) != nil {
		return keys
	}
	for _, b := range out.Blockdevices {
		if b.Serial != nil && strings.TrimSpace(*b.Serial) != "" {
			keys[strings.TrimSpace(*b.Serial)] = true
		}
		if b.WWN != nil && strings.TrimSpace(*b.WWN) != "" {
			keys[strings.TrimSpace(*b.WWN)] = true
		}
	}
	return keys
}

// scanArrayByUUID finds the array with uuid in "mdadm --detail --scan",
// which names an inactive (partly assembled) array INACTIVE-ARRAY.
func scanArrayByUUID(out, uuid string, realPath func(string) string) (md string, active bool) {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		inactive := strings.HasPrefix(l, "INACTIVE-ARRAY ")
		if dev, u := arrayLineFields(strings.TrimPrefix(l, "INACTIVE-")); u == uuid && dev != "" {
			return filepath.Base(realPath(dev)), !inactive
		}
	}
	return "", false
}

func collectLive(d storageDescription) liveVolume {
	l := liveVolume{Connected: map[string]bool{}}
	mounts := hostProcMounts()
	uuidOf := map[string]string{}
	for _, line := range strings.Split(hostUUIDDevices(), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		if _, seen := uuidOf[f[0]]; !seen && f[1] == d.Filesystem.UUID {
			l.FSDevices = append(l.FSDevices, f[0])
		}
		uuidOf[f[0]] = f[1]
	}
	aliases := append([]string{}, l.FSDevices...)
	if d.LVM != nil {
		aliases = append(aliases, "/dev/"+d.LVM.VG+"/"+d.LVM.LV, lvDmPath(d.LVM.VG, d.LVM.LV))
		l.VGActive = hostExists(lvDmPath(d.LVM.VG, d.LVM.LV))
	}
	l.MountedOn = mountPointOf(mounts, aliases...)
	if l.MountedOn == "" {
		for _, line := range strings.Split(mounts, "\n") {
			if f := strings.Fields(line); len(f) >= 2 && f[1] == d.Mount.Point {
				l.MountPointUUID = uuidOf[f[0]]
				if l.MountPointUUID == "" {
					l.MountPointUUID = f[0] // a filesystem without a UUID (tmpfs): name its source
				}
			}
		}
	}
	for _, v := range hsiVolumes(readFstab()) {
		if v.MountPoint == d.Mount.Point {
			l.FstabPresent, l.FstabUUID, l.FstabOptions = true, v.UUID, v.Options
		}
	}
	// A disk with a serial or WWN is connected wherever it shows up; one
	// without either is known only by its link.
	present := hostDiskKeys()
	for _, k := range d.Disks {
		key := diskKey(k)
		if key == k.ByID {
			l.Connected[key] = hostExists(k.ByID)
		} else {
			l.Connected[key] = present[key]
		}
	}
	byID := preferredByID(hostByIDLinks())
	if d.Array != nil {
		for _, line := range splitConf(readMdadmConf()) {
			if _, u := arrayLineFields(strings.TrimSpace(line)); u == d.Array.UUID {
				l.MdadmConfHasArray = true
			}
		}
		if md := hostArrayByUUID(d.Array.UUID); md == "" {
			l.ArrayInactive = hostInactiveArrayByUUID(d.Array.UUID)
		} else {
			l.ArrayDev = md
			detail, _ := hostMdDetail("/dev/" + md)
			l.ArrayLevel = mdDetailField(detail, "Raid Level")
			l.ArrayMembers = map[string]string{}
			for _, m := range mdMembers(detail) {
				k := diskKey(describeDisk(m.Dev, m.Role, byID))
				l.ArrayMembers[k] = m.Role
				l.Connected[k] = true
			}
		}
	}
	return l
}

func diffDescription(d storageDescription, l liveVolume) []driftItem {
	var items []driftItem
	add := func(kind, format string, args ...any) {
		items = append(items, driftItem{Kind: kind, Text: fmt.Sprintf(format, args...)})
	}
	mp := d.Mount.Point
	switch {
	case l.MountedOn == mp:
	case l.MountedOn != "":
		add("mounted-elsewhere", "The filesystem is mounted on %s instead of %s", l.MountedOn, mp)
	case l.MountPointUUID != "" && l.MountPointUUID != d.Filesystem.UUID:
		add("fs-changed", "The filesystem on %s is no longer %s (now %s)", mp, d.Filesystem.UUID, l.MountPointUUID)
	default:
		add("not-mounted", "%s is not mounted", mp)
	}
	if !l.FstabPresent {
		add("fstab-missing", "The fstab entry for %s is missing", mp)
	} else if l.FstabUUID != d.Filesystem.UUID {
		add("fstab-changed", "The fstab entry for %s changed (filesystem %s instead of %s)", mp, l.FstabUUID, d.Filesystem.UUID)
	} else if l.FstabOptions != d.Mount.Options {
		add("fstab-changed", "The fstab entry for %s changed (options %s instead of %s)", mp, l.FstabOptions, d.Mount.Options)
	}

	running := true
	if a := d.Array; a != nil {
		name := a.Name
		if l.ArrayDev != "" {
			name = l.ArrayDev
		}
		if l.ArrayDev == "" {
			running = false
			add("array-stopped", "Array %s (%s) is not running", a.UUID, a.Name)
		} else if l.ArrayLevel != "" && l.ArrayLevel != a.Level {
			add("array-level", "%s is %s, described as %s", name, l.ArrayLevel, a.Level)
		}
		if !l.MdadmConfHasArray {
			add("mdadm-conf-missing", "mdadm.conf has no ARRAY line for %s", name)
		}
		described := map[string]bool{}
		for _, k := range d.Disks {
			key := diskKey(k)
			described[key] = true
			switch {
			case !l.Connected[key]:
				add("disk-missing", "Disk %s is not connected", key)
				items[len(items)-1].Role = k.Role
			case running && l.ArrayMembers[key] == "":
				add("disk-not-member", "Disk %s is no longer in %s", key, name)
			}
		}
		var extra []string
		for serial := range l.ArrayMembers {
			if !described[serial] {
				extra = append(extra, serial)
			}
		}
		sort.Strings(extra)
		for _, serial := range extra {
			add("disk-new-member", "Disk %s is in %s but not in the description", serial, name)
		}
	} else {
		for _, k := range d.Disks {
			if !l.Connected[diskKey(k)] {
				add("disk-missing", "Disk %s is not connected", diskKey(k))
				items[len(items)-1].Role = k.Role
			}
		}
	}
	// A stopped array leaves its volume group inactive: that says nothing more.
	if d.LVM != nil && running && !l.VGActive {
		add("vg-inactive", "Volume group %s is not active", d.LVM.VG)
	}
	// Unmounted and nothing else: a volume unmounted on purpose, which the
	// Volumes page offers to mount. Not a difference from the description.
	if len(items) == 1 && items[0].Kind == "not-mounted" {
		return nil
	}
	return items
}

type descriptionStatus struct {
	MountPoint  string             `json:"mountPoint"`
	File        string             `json:"file"`
	Items       []driftItem        `json:"items"`
	Description storageDescription `json:"description"`
}

func descriptionStatuses() []descriptionStatus {
	all, files := loadDescriptions()
	var mps []string
	for mp := range all {
		mps = append(mps, mp)
	}
	sort.Strings(mps)
	out := []descriptionStatus{}
	for _, mp := range mps {
		d := all[mp]
		items := diffDescription(d, collectLiveFn(d))
		if items == nil {
			items = []driftItem{}
		}
		out = append(out, descriptionStatus{MountPoint: mp, File: files[mp], Items: items, Description: d})
	}
	// Files a hand edit broke: reported on the volume named after them.
	var brokenFiles []string
	broken := brokenDescriptions()
	for f := range broken {
		brokenFiles = append(brokenFiles, f)
	}
	sort.Strings(brokenFiles)
	for _, f := range brokenFiles {
		mp := ""
		for _, v := range hsiVolumes(readFstab()) {
			if filepath.Join(storageDescriptionsDir(), descriptionName(v.MountPoint)+".yaml") == f {
				mp = v.MountPoint
			}
		}
		out = append(out, descriptionStatus{MountPoint: mp, File: f,
			Items: []driftItem{{Kind: "unreadable", Text: "The description file " + f + " cannot be read (" + broken[f].Error() + "): Accept the current state to write it again"}}})
	}
	return out
}

func handleStorageDescriptions(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"descriptions": descriptionStatuses()})
}

// runStorageCLI is `hsi-worker storage diff`.
func runStorageCLI(args []string) int {
	if len(args) != 1 || args[0] != "diff" {
		fmt.Println("usage: hsi-worker storage diff")
		return 2
	}
	for _, s := range descriptionStatuses() {
		fmt.Printf("%s (%s)\n", s.MountPoint, filepath.Base(s.File))
		if len(s.Items) == 0 {
			fmt.Println("  OK")
		}
		for _, i := range s.Items {
			fmt.Println("  " + i.Text)
		}
	}
	return 0
}
