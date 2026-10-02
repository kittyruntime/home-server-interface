package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// ── Plan builder: remove a data volume (#40) ─────────────────────────────────
// The counterpart of volume.create: unmount, forget at boot, then tear down
// the stack under the filesystem as far as it serves only this volume (LV,
// VG, PVs, array), and erase the signatures so the disks show as free.

var (
	hostDevByUUID = func(uuid string) string {
		out, _ := command("blkid", "-U", uuid).Output()
		return strings.TrimSpace(string(out))
	}
	hostPvs  = func() []lvmPV { pvs, _, _ := getLvmInfo(); return pvs }
	hostBusy = func(mp string) []string {
		// fuser prints the PIDs on stdout and the "USER PID ACCESS COMMAND"
		// table on stderr; the command names are the last column.
		out, _ := command("fuser", "-vm", mp).CombinedOutput()
		seen := map[string]bool{}
		var names []string
		for _, l := range strings.Split(string(out), "\n")[1:] {
			f := strings.Fields(l)
			if len(f) < 2 || f[len(f)-1] == "kernel" || seen[f[len(f)-1]] {
				continue
			}
			seen[f[len(f)-1]] = true
			names = append(names, f[len(f)-1])
		}
		return names
	}
)

// mountPointOf returns where dev (or one of its aliases) is mounted, if it is.
func mountPointOf(procMounts string, aliases ...string) string {
	for _, l := range strings.Split(procMounts, "\n") {
		f := strings.Fields(l)
		if len(f) < 2 {
			continue
		}
		for _, a := range aliases {
			if f[0] == a {
				return f[1]
			}
		}
	}
	return ""
}

// fstabMountPointFor returns the mount point of the fstab entry for UUID=uuid.
func fstabMountPointFor(conf, uuid string) string {
	for _, l := range splitConf(conf) {
		if src, mp := fstabFields(l); src == "UUID="+uuid {
			return mp
		}
	}
	return ""
}

func planVolumeRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if req.UUID == "" || strings.ContainsAny(req.UUID, " \t\n/") {
		return nil, &fsError{Code: "ERR", Message: "invalid volume id"}
	}
	dev := hostDevByUUID(req.UUID)
	if dev == "" {
		return nil, &fsError{Code: "ENOENT", Message: "no filesystem with UUID " + req.UUID + " on this server"}
	}

	// The LV this filesystem is on, if any.
	var lv *lvmLV
	for _, l := range hostLvs() {
		if l.Path == dev || lvDmPath(l.VGName, l.Name) == dev {
			l := l
			lv = &l
			break
		}
	}
	aliases := []string{dev}
	if lv != nil {
		aliases = append(aliases, lv.Path, lvDmPath(lv.VGName, lv.Name))
	}

	fstab := readFstab()
	mounts := hostProcMounts()
	mp := mountPointOf(mounts, aliases...)
	mounted := mp != ""
	if !mounted {
		mp = fstabMountPointFor(fstab, req.UUID)
	}
	if mp != "" && criticalMountPoints[filepath.Clean(mp)] {
		return nil, &fsError{Code: "ESYS", Message: mp + " is a system directory"}
	}
	if mounted {
		if who := hostBusy(mp); len(who) > 0 {
			return nil, &fsError{Code: "EBUSY", Message: mp + " is in use by " + strings.Join(who, ", ") + "; stop them first"}
		}
	}

	obs := map[string]string{"device": dev, "mountpoint": mp, "mounted": fmt.Sprint(mounted), "fstab": fstab, "mdadm.conf": readMdadmConf()}
	var steps []planStep

	// The stack, from the filesystem down, kept to what serves only this volume.
	var vgExclusive bool
	var pvs []string
	if lv != nil {
		var others []string
		for _, l := range hostLvs() {
			if l.VGName == lv.VGName && l.Name != lv.Name {
				others = append(others, l.Name)
			}
		}
		sort.Strings(others)
		obs["lvs"] = strings.Join(append([]string{lv.Name}, others...), ",")
		vgExclusive = len(others) == 0
		if !vgExclusive {
			word := "logical volumes"
			if len(others) == 1 {
				word = "logical volume"
			}
			steps = append(steps, planStep{Kind: "info", Target: lv.VGName,
				Summary: fmt.Sprintf("%s keeps %d other %s: it stays", lv.VGName, len(others), word)})
		}
		for _, p := range hostPvs() {
			if p.VGName == lv.VGName {
				pvs = append(pvs, p.Name)
			}
		}
		sort.Strings(pvs)
		obs["pvs"] = strings.Join(pvs, " ")
	}

	// Arrays to stop: the PVs of an exclusive VG, or the filesystem's own device.
	type array struct {
		dev, name, uuid string
		members         []string
	}
	var arrays []array
	addArray := func(d string) bool {
		name := filepath.Base(d)
		if !reMdDev.MatchString(name) {
			return false
		}
		detail, err := hostMdDetail(d)
		members, uuid := parseMdDetail(detail)
		if err != nil || len(members) == 0 {
			return false
		}
		arrays = append(arrays, array{d, name, uuid, members})
		obs["members:"+name] = strings.Join(members, " ")
		return true
	}
	var base []string // devices under the stack that become free
	switch {
	case lv != nil && vgExclusive:
		for _, p := range pvs {
			if addArray(p) {
				base = append(base, arrays[len(arrays)-1].members...)
			} else {
				base = append(base, p)
			}
		}
	case lv == nil:
		if addArray(dev) {
			base = append(base, arrays[len(arrays)-1].members...)
		} else {
			base = append(base, dev)
		}
	}

	// Never touch the system disk, whatever path led to it.
	sys := hostSystemDevs()
	check := append([]string{dev}, pvs...)
	check = append(check, base...)
	for _, d := range check {
		if sys[filepath.Base(d)] {
			return nil, &fsError{Code: "ESYS", Message: d + " belongs to the system disk"}
		}
	}
	for _, d := range base {
		observeDevice(obs, "wipe:"+d, d)
	}

	if mounted {
		steps = append(steps, cmdStep(mp, "Unmount "+mp, []string{"umount", mp}))
	}
	if mp != "" {
		if s, _ := fstabStep("Stop mounting "+mp+" at boot", fstab, func(conf string) (string, error) {
			return removeFstabLines(conf, mp, append(aliases, "UUID="+req.UUID)...), nil
		}); s.Diff != "" {
			steps = append(steps, s)
		}
		if mounted || hostExists(mp) {
			unprotect := cmdStep(mp, "Make "+mp+" an ordinary folder again", []string{"chattr", "-i", mp})
			unprotect.OnFailure = "warn"
			steps = append(steps, unprotect)
		}
	}

	if lv != nil {
		steps = append(steps, destructive(cmdStep(lv.Path, "Delete the logical volume "+lv.Path+" and everything on it",
			[]string{"lvremove", "-f", lv.Path}), lv.Path))
		if vgExclusive {
			steps = append(steps,
				cmdStep(lv.VGName, "Delete the volume group "+lv.VGName, []string{"vgremove", "-f", lv.VGName}),
				cmdStep(lv.VGName, "Release "+strings.Join(pvs, ", ")+" from LVM", append([]string{"pvremove", "-f"}, pvs...)))
		}
	}

	if len(arrays) > 0 {
		var names []string
		for _, a := range arrays {
			names = append(names, a.dev)
			steps = append(steps, cmdStep(a.dev, "Stop the RAID array "+a.dev, []string{"mdadm", "--stop", a.dev}))
			for _, m := range a.members {
				steps = append(steps, destructive(cmdStep(m, "Erase the RAID signature on "+m,
					[]string{"mdadm", "--zero-superblock", m}), m))
			}
		}
		edit := func(conf string) string {
			for _, a := range arrays {
				conf = removeArrayEntries(conf, a.name, a.uuid)
			}
			return conf
		}
		before := obs["mdadm.conf"]
		if after := edit(before); after != before {
			s := planStep{Kind: "update", Target: mdadmConfPath, OnFailure: "warn",
				Summary: "Forget " + strings.Join(names, ", ") + " in mdadm.conf", Diff: unifiedDiff(mdadmConfPath, before, after),
				run: func() (string, error) { return "", editMdadmConf(edit) }}
			steps = append(steps, s)
			if s, ok := initramfsStep(); ok {
				steps = append(steps, s)
			}
		}
	}

	for _, d := range base {
		steps = append(steps, cmdStep(d, "Erase the remaining signatures on "+d+" so it shows as free", []string{"wipefs", "-a", d}))
	}
	freed := append([]string{}, base...)
	return &opPlan{Op: "volume.remove", Steps: steps, Observed: obs,
		Reply: map[string]any{"freed": freed, "mountpoint": mp}}, nil
}
