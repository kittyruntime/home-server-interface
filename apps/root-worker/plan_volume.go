package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ── Plan builder: create a volume from free disks (#40) ─────────────────────
// One plan for the whole chain: array (when redundant), LVM, filesystem,
// mount, permissions. Devices created by earlier steps do not exist at
// preview time, so the steps are built from the request, and what is only
// known after a step ran (mdadm.conf ARRAY line, fstab UUID) is deferred.

var (
	hostMdNames = func() []string {
		b, _ := os.ReadFile("/proc/mdstat")
		var names []string
		for _, r := range parseMdstat(string(b)) {
			names = append(names, r.Name)
		}
		return names
	}
	// /dev/md* nodes too: an array stopped but still configured keeps its name.
	hostMdNodes = func() []string {
		var names []string
		for _, pat := range []string{"/dev/md[0-9]*", "/dev/md/*"} {
			m, _ := filepath.Glob(pat)
			for _, p := range m {
				names = append(names, filepath.Base(p))
			}
		}
		return names
	}
	// A whole disk: lsblk type "disk" (not a partition, md or dm device).
	hostWholeDisk = func(name string) bool {
		out, err := command("lsblk", "-dn", "-o", "TYPE", "/dev/"+name).Output()
		return err == nil && strings.TrimSpace(string(out)) == "disk"
	}
	hostVgNames = func() []string {
		out, _ := hostOutput("vgs", "--noheadings", "-o", "vg_name")
		return strings.Fields(string(out))
	}
	hostMkdir    = func(path string) error { return os.MkdirAll(path, 0o755) }
	hostDirEmpty = func(path string) bool {
		entries, err := os.ReadDir(path)
		return err == nil && len(entries) == 0
	}
)

var reFsLabel = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,16}$`)

// Minimum disks per redundancy, and the mdadm level.
var volumeLevels = map[string]struct {
	min   int
	level string
}{
	"raid1": {2, "1"}, "raid5": {3, "5"}, "raid6": {4, "6"}, "raid10": {4, "10"},
}

// nextMdName returns the first mdN name not used by a running array, a
// /dev node, or an ARRAY line of mdadm.conf (an array that is not assembled
// right now would lose its line otherwise).
// mdadmConfNames returns the mdN names of the ARRAY lines of mdadm.conf.
func mdadmConfNames(conf string) []string {
	var names []string
	for _, l := range splitConf(conf) {
		if dev, _ := arrayLineFields(strings.TrimSpace(l)); dev != "" {
			names = append(names, filepath.Base(dev))
		}
	}
	return names
}

func nextMdName(used []string, mdadmConf string) string {
	taken := map[string]bool{}
	for _, n := range used {
		taken[n] = true
	}
	for _, l := range splitConf(mdadmConf) {
		if dev, _ := arrayLineFields(strings.TrimSpace(l)); dev != "" {
			taken[filepath.Base(dev)] = true
		}
	}
	for i := 0; ; i++ {
		if n := fmt.Sprintf("md%d", i); !taken[n] {
			return n
		}
	}
}

func planVolumeCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Disks      []string `json:"disks"`
		Redundancy string   `json:"redundancy"`
		VG         string   `json:"vg"`
		LV         string   `json:"lv"`
		LVPercent  int      `json:"lvPercent"`
		Label      string   `json:"label"`
		MountPoint string   `json:"mountpoint"`
		Access     string   `json:"access"`
		OwnerUser  string   `json:"ownerUser"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if len(req.Disks) == 0 {
		return nil, &fsError{Code: "ERR", Message: "choose at least one disk"}
	}
	if req.Redundancy != "none" {
		lv, ok := volumeLevels[req.Redundancy]
		if !ok {
			return nil, &fsError{Code: "ERR", Message: "unsupported redundancy " + req.Redundancy}
		}
		if len(req.Disks) < lv.min {
			return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("%s needs at least %d disks (got %d)", req.Redundancy, lv.min, len(req.Disks))}
		}
	}
	if !reVGName.MatchString(req.VG) || !reVGName.MatchString(req.LV) {
		return nil, &fsError{Code: "ERR", Message: "invalid volume group or logical volume name"}
	}
	for _, v := range hostVgNames() {
		if v == req.VG {
			return nil, &fsError{Code: "EEXIST", Message: "a volume group named " + req.VG + " already exists"}
		}
	}
	if req.LVPercent < 1 || req.LVPercent > 100 {
		return nil, &fsError{Code: "ERR", Message: "the logical volume must use between 1 and 100% of the volume group"}
	}
	if !reFsLabel.MatchString(req.Label) {
		return nil, &fsError{Code: "ERR", Message: "the label must be 1 to 16 letters, digits, dots, dashes or underscores"}
	}
	mp, fe := validMountPoint(req.MountPoint)
	if fe != nil {
		return nil, fe
	}
	if criticalMountPoints[mp] {
		return nil, &fsError{Code: "ESYS", Message: "cannot mount over system directory " + mp}
	}
	fstab := readFstab()
	for _, l := range splitConf(fstab) {
		if _, m := fstabFields(l); m == mp {
			return nil, &fsError{Code: "EEXIST", Message: fstabPath + " already has an entry for " + mp + "; choose another folder"}
		}
	}
	exists := hostExists(mp)
	if exists && !hostDirEmpty(mp) {
		return nil, &fsError{Code: "ERR", Message: mp + " is not empty; choose another folder"}
	}
	for _, tool := range []string{"pvcreate", "mkfs.ext4"} {
		if !hostLookPath(tool) {
			return nil, &fsError{Code: "ENOTOOL", Message: tool + " is not installed; install lvm2 and e2fsprogs"}
		}
	}
	if req.Redundancy != "none" && !hostLookPath("mdadm") {
		return nil, &fsError{Code: "ENOTOOL", Message: "mdadm is not installed; install it with: sudo apt install mdadm"}
	}

	sys := hostSystemDevs()
	mdConf := readMdadmConf()
	obs := map[string]string{"fstab": fstab, "mdadm.conf": mdConf, "mountpoint": fmt.Sprint(exists)}
	disks := make([]string, 0, len(req.Disks))
	seen := map[string]bool{}
	for _, d := range req.Disks {
		if !reBlockDev.MatchString(d) {
			return nil, &fsError{Code: "ERR", Message: "invalid device name: " + d}
		}
		if seen[d] {
			return nil, &fsError{Code: "ERR", Message: d + " is listed twice"}
		}
		seen[d] = true
		if sys[d] {
			return nil, &fsError{Code: "ESYS", Message: "device " + d + " belongs to the system disk"}
		}
		if !hostWholeDisk(d) {
			return nil, &fsError{Code: "ERR", Message: d + " is not a whole disk; a volume is built from whole disks"}
		}
		if fe := hostClaimable(d); fe != nil {
			return nil, fe
		}
		disks = append(disks, "/dev/"+d)
		observeDevice(obs, "/dev/"+d, "/dev/"+d)
	}

	var steps []planStep
	pvs := disks
	if req.Redundancy != "none" {
		name := nextMdName(append(hostMdNames(), hostMdNodes()...), mdConf)
		obs["md"] = name
		raidDev := "/dev/" + name
		lvl := volumeLevels[req.Redundancy].level
		args := append([]string{"mdadm", "--create", raidDev, "--level", lvl, "--raid-devices", fmt.Sprint(len(disks)), "--run"}, disks...)
		steps = append(steps, destructiveAll(cmdStep(raidDev,
			fmt.Sprintf("Create the RAID %s array %s from %s, erasing their contents", lvl, raidDev, strings.Join(disks, ", ")), args), disks))
		steps = append(steps, planStep{Kind: "update", Target: mdadmConfPath, Deferred: true, OnFailure: "warn",
			Summary: "Add the ARRAY line of " + raidDev + " to mdadm.conf so it assembles under the same name at boot",
			run: func() (string, error) {
				brief, err := hostMdBrief(raidDev)
				line := briefArrayLine(brief)
				if line == "" {
					return "", fmt.Errorf("could not read the array definition: %s", cmdErrMessage([]byte(brief), err))
				}
				before := readMdadmConf()
				if err := editMdadmConf(func(conf string) string { return upsertArrayLine(conf, name, line) }); err != nil {
					return "", err
				}
				return unifiedDiff(mdadmConfPath, before, readMdadmConf()), nil
			}})
		if s, ok := initramfsStep(); ok {
			steps = append(steps, s)
		}
		pvs = []string{raidDev}
		// Old signatures inside the new array (an LVM label from a previous
		// life of these disks) would make pvcreate stop and ask.
		steps = append(steps, cmdStep(raidDev, "Clear old signatures inside "+raidDev, []string{"wipefs", "-a", raidDev}))
	}

	pv := cmdStep(req.VG, "Prepare "+strings.Join(pvs, ", ")+" for LVM", append([]string{"pvcreate", "-f"}, pvs...))
	if req.Redundancy == "none" {
		pv = destructiveAll(cmdStep(req.VG, "Prepare "+strings.Join(pvs, ", ")+" for LVM, erasing their contents", append([]string{"pvcreate", "-f"}, pvs...)), pvs)
	}
	lvDev := "/dev/" + req.VG + "/" + req.LV
	steps = append(steps,
		pv,
		cmdStep(req.VG, "Create the volume group "+req.VG, append([]string{"vgcreate", req.VG}, pvs...)),
		cmdStep(lvDev, fmt.Sprintf("Create the logical volume %s using %d%% of the volume group", req.LV, req.LVPercent),
			[]string{"lvcreate", "-y", "-l", fmt.Sprintf("%d%%FREE", req.LVPercent), "-n", req.LV, req.VG}),
		cmdStep(lvDev, "Create an ext4 filesystem labelled "+req.Label, []string{"mkfs.ext4", "-F", "-E", "nodiscard", "-L", req.Label, lvDev}),
	)

	if !exists {
		steps = append(steps, planStep{Kind: "create", Target: mp, Summary: "Create the folder " + mp,
			run: func() (string, error) { return "", hostMkdir(mp) }})
	}
	protect := cmdStep(mp, "Protect "+mp+" so nothing is written to the system disk when the volume is missing", []string{"chattr", "+i", mp})
	protect.OnFailure = "warn"
	steps = append(steps, protect, cmdStep(mp, "Mount "+lvDev+" on "+mp, []string{"mount", lvDev, mp}))

	// The filesystem UUID exists only after mkfs.
	steps = append(steps, planStep{Kind: "update", Target: fstabPath, Deferred: true,
		Summary: "Mount " + mp + " again at every boot (by the new filesystem's UUID)",
		run: func() (string, error) {
			uuid := hostBlkid(lvDev, "UUID")
			if uuid == "" {
				return "", fmt.Errorf("mounted on %s, but its UUID could not be read: not saved for reboot", mp)
			}
			source := "UUID=" + uuid
			entry := fmt.Sprintf("%s\t%s\text4\t%s\t0\t2", source, mp, withBootOptions("defaults"))
			before := readFstab()
			if err := editFstab(func(conf string) (string, error) { return upsertFstabEntry(conf, mp, source, entry) }); err != nil {
				return "", fmt.Errorf("mounted on %s, but not saved for reboot: %v", mp, err)
			}
			return unifiedDiff(fstabPath, before, readFstab()), nil
		}})

	if req.Access == "shared" || req.Access == "user" {
		who := "the hsi-share group"
		if req.OwnerUser != "" {
			who = req.OwnerUser + " and the hsi-share group"
		}
		steps = append(steps, planStep{Kind: "permissions", Target: mp, Summary: "Make " + mp + " writable by " + who, OnFailure: "warn",
			run: func() (string, error) {
				if ws := hostPrepareRoot(mp, req.OwnerUser, false); len(ws) > 0 {
					return "", fmt.Errorf("%s", strings.Join(ws, "; "))
				}
				return "", nil
			}})
	}
	return &opPlan{Op: "volume.create", Steps: steps, Observed: obs, Describe: []string{mp},
		Reply: map[string]any{"device": lvDev, "mountpoint": mp}}, nil
}
