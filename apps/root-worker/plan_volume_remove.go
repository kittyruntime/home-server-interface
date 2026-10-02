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
	// Every device carrying the UUID: a clone or a snapshot carries it too.
	hostDevsByUUID = func(uuid string) []string {
		out, _ := command("blkid", "-o", "device", "-t", "UUID="+uuid).Output()
		return strings.Fields(string(out))
	}
	hostPvs = func() []lvmPV { pvs, _, _ := getLvmInfo(); return pvs }
	// /dev/md/<name> and other links, resolved to the kernel device.
	hostRealPath = func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return p
	}
	hostBusy = func(mp string) []string {
		// The PIDs go to stdout, the table to stderr.
		out, _ := command("fuser", "-vm", mp).CombinedOutput()
		return parseFuser(string(out))
	}
)

// parseFuser returns the commands using a mount from "fuser -vm" output:
//
//	                     USER        PID ACCESS COMMAND
//	/srv/data:           root     kernel mount /srv/data
//	                     theo       1234 ..c.. bash
//
// The kernel's own mount row is not a process.
func parseFuser(out string) []string {
	seen := map[string]bool{}
	var names []string
	for _, l := range strings.Split(out, "\n") {
		f := strings.Fields(l)
		if len(f) < 4 || f[len(f)-1] == "COMMAND" || containsString(f, "kernel") {
			continue
		}
		if name := f[len(f)-1]; !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

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

// fstabMountPointFor returns the mount point of the first fstab entry whose
// source is one of sources.
func fstabMountPointFor(conf string, sources []string) string {
	for _, l := range splitConf(conf) {
		if src, mp := fstabFields(l); src != "" && containsString(sources, src) {
			return mp
		}
	}
	return ""
}

func planVolumeRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		UUID string `json:"uuid"`
		// SMB shares of this volume the caller removed from Samba before this
		// plan runs: their open sessions are closed before the unmount, so
		// smbd holding the folder at preview time is expected.
		CloseShares []string `json:"closeShares"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if req.UUID == "" || strings.ContainsAny(req.UUID, " \t\n/") {
		return nil, &fsError{Code: "ERR", Message: "invalid volume id"}
	}
	for _, n := range req.CloseShares {
		if !reSmbShareName.MatchString(n) {
			return nil, &fsError{Code: "ERR", Message: "invalid share name: " + n}
		}
	}
	devs := hostDevsByUUID(req.UUID)
	if len(devs) == 0 {
		return nil, &fsError{Code: "ENOENT", Message: "no filesystem with UUID " + req.UUID + " on this server"}
	}
	// A btrfs spread over several disks carries its UUID on each of them;
	// anything else carrying a UUID twice is a clone or a snapshot.
	multi := len(devs) > 1
	if multi {
		for _, d := range devs {
			if hostBlkid(d, "TYPE") != "btrfs" {
				return nil, &fsError{Code: "ERR", Message: "several devices carry this filesystem (" + strings.Join(devs, ", ") + "), a clone or a snapshot: remove it by hand"}
			}
		}
	}
	dev := devs[0]

	// The LV this filesystem is on, if any.
	var lv *lvmLV
	for _, l := range hostLvs() {
		if l.Path == dev || lvDmPath(l.VGName, l.Name) == dev {
			l := l
			lv = &l
			break
		}
	}
	aliases := append([]string{}, devs...)
	if lv != nil {
		aliases = append(aliases, lv.Path, lvDmPath(lv.VGName, lv.Name))
	}
	// Every way fstab can name this filesystem: the device is destroyed, so
	// none of its entries may stay (one without nofail would stop the boot).
	sources := append(append([]string{}, aliases...), "UUID="+req.UUID)

	fstab := readFstab()
	mounts := hostProcMounts()
	mp := mountPointOf(mounts, aliases...)
	mounted := mp != ""
	if !mounted {
		mp = fstabMountPointFor(fstab, sources)
	}
	if mp != "" && criticalMountPoints[filepath.Clean(mp)] {
		return nil, &fsError{Code: "ESYS", Message: mp + " is a system directory"}
	}
	if mounted {
		var who []string
		for _, w := range hostBusy(mp) {
			if !(len(req.CloseShares) > 0 && w == "smbd") {
				who = append(who, w)
			}
		}
		if len(who) > 0 {
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
		d = hostRealPath(d)
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
	case lv == nil && multi:
		base = append(base, devs...)
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
		for _, n := range req.CloseShares {
			c := cmdStep("smbd", "Close the open SMB sessions on the share "+n, []string{"smbcontrol", "smbd", "close-share", n})
			c.OnFailure = "ignore"
			steps = append(steps, c)
		}
		steps = append(steps, cmdStep(mp, "Unmount "+mp, []string{"umount", mp}))
	}
	if s, _ := fstabStep("Stop mounting "+mp+" at boot", fstab, func(conf string) (string, error) {
		if mp != "" {
			conf = removeFstabLines(conf, mp, sources...)
		}
		return removeFstabSources(conf, sources...), nil
	}); s.Diff != "" {
		steps = append(steps, s)
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
		// Stop, forget, then erase: a failed erase leaves no ARRAY line that
		// would bring a half-erased array back at boot.
		conf := obs["mdadm.conf"]
		changed := false
		for _, a := range arrays {
			steps = append(steps, cmdStep(a.dev, "Stop the RAID array "+a.dev, []string{"mdadm", "--stop", a.dev}))
			a := a
			edit := func(c string) string { return removeArrayEntries(c, a.name, a.uuid) }
			if after := edit(conf); after != conf {
				steps = append(steps, planStep{Kind: "update", Target: mdadmConfPath, OnFailure: "warn",
					Summary: "Forget " + a.dev + " in mdadm.conf", Diff: unifiedDiff(mdadmConfPath, conf, after),
					run: func() (string, error) { return "", editMdadmConf(edit) }})
				conf, changed = after, true
			}
			for _, m := range a.members {
				steps = append(steps, destructive(cmdStep(m, "Erase the RAID signature on "+m,
					[]string{"mdadm", "--zero-superblock", m}), m))
			}
		}
		if changed {
			if s, ok := initramfsStep(); ok {
				steps = append(steps, s)
			}
		}
	}

	named := map[string]bool{} // disks an earlier step already names as erased
	for _, a := range arrays {
		for _, m := range a.members {
			named[m] = true
		}
	}
	for _, d := range base {
		s := cmdStep(d, "Erase the remaining signatures on "+d+" so it shows as free", []string{"wipefs", "-a", d})
		if !named[d] {
			s = destructive(s, d)
		}
		steps = append(steps, s)
	}
	// Erasing a filesystem signature sends no uevent: without this, lsblk
	// keeps showing the old filesystem on the freed disks.
	if len(base) > 0 {
		trigger := cmdStep("udev", "Have udev read "+strings.Join(base, ", ")+" again", append([]string{"udevadm", "trigger", "--action=change"}, base...))
		trigger.OnFailure = "ignore"
		settle := cmdStep("udev", "Wait for udev", []string{"udevadm", "settle"})
		settle.OnFailure = "ignore"
		steps = append(steps, trigger, settle)
	}
	// Last: until the volume is fully gone, the empty folder stays immutable,
	// so a share brought back after a failure cannot write to the system disk.
	if mp != "" && (mounted || hostExists(mp)) {
		unprotect := cmdStep(mp, "Make "+mp+" an ordinary folder again", []string{"chattr", "-i", mp})
		unprotect.OnFailure = "warn"
		steps = append(steps, unprotect)
	}
	freed := append([]string{}, base...)
	return &opPlan{Op: "volume.remove", Steps: steps, Observed: obs,
		Reply: map[string]any{"freed": freed, "mountpoint": mp}}, nil
}
