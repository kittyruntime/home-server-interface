package main

import (
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
	ArrayLevel        string            // its level
	ArrayMembers      map[string]string // its members: serial -> active/spare
	MdadmConfHasArray bool              // an ARRAY line for the described UUID
	VGActive          bool
	Connected         map[string]bool // described disks by serial: connected or not
}

var (
	// hostLVActive tells whether an LV is active.
	hostLVActive = func(vg, lv string) bool {
		out, _ := hostOutput("lvs", "--noheadings", "-o", "lv_active", vg+"/"+lv)
		return strings.TrimSpace(string(out)) == "active"
	}
	collectLiveFn = collectLive
)

func collectLive(d storageDescription) liveVolume {
	l := liveVolume{Connected: map[string]bool{}}
	mounts := hostProcMounts()
	l.FSDevices = hostDevsByUUID(d.Filesystem.UUID)
	aliases := append([]string{}, l.FSDevices...)
	if d.LVM != nil {
		aliases = append(aliases, "/dev/"+d.LVM.VG+"/"+d.LVM.LV, lvDmPath(d.LVM.VG, d.LVM.LV))
		l.VGActive = hostLVActive(d.LVM.VG, d.LVM.LV)
	}
	l.MountedOn = mountPointOf(mounts, aliases...)
	if l.MountedOn == "" {
		for _, line := range strings.Split(mounts, "\n") {
			if f := strings.Fields(line); len(f) >= 2 && f[1] == d.Mount.Point {
				l.MountPointUUID = hostBlkid(f[0], "UUID")
			}
		}
	}
	for _, v := range hsiVolumes(readFstab()) {
		if v.MountPoint == d.Mount.Point {
			l.FstabPresent, l.FstabUUID, l.FstabOptions = true, v.UUID, v.Options
		}
	}
	for _, k := range d.Disks {
		l.Connected[k.Serial] = hostExists(k.ByID)
	}
	if d.Array != nil {
		for _, line := range splitConf(readMdadmConf()) {
			if _, u := arrayLineFields(strings.TrimSpace(line)); u == d.Array.UUID {
				l.MdadmConfHasArray = true
			}
		}
		if md := hostArrayByUUID(d.Array.UUID); md != "" {
			l.ArrayDev = md
			detail, _ := hostMdDetail("/dev/" + md)
			l.ArrayLevel = mdDetailField(detail, "Raid Level")
			l.ArrayMembers = map[string]string{}
			for _, m := range mdMembers(detail) {
				disk, _ := hostParentDisk(m.Dev)
				serial, _, _ := hostDiskIdentity(disk)
				l.ArrayMembers[serial] = m.Role
				l.Connected[serial] = true
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
			described[k.Serial] = true
			switch {
			case !l.Connected[k.Serial]:
				add("disk-missing", "Disk %s is not connected", k.Serial)
			case running && l.ArrayMembers[k.Serial] == "":
				add("disk-not-member", "Disk %s is no longer in %s", k.Serial, name)
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
			if !l.Connected[k.Serial] {
				add("disk-missing", "Disk %s is not connected", k.Serial)
			}
		}
	}
	// A stopped array leaves its volume group inactive: that says nothing more.
	if d.LVM != nil && running && !l.VGActive {
		add("vg-inactive", "Volume group %s is not active", d.LVM.VG)
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
