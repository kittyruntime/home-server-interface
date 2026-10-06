package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ── Plan builders: reapply or accept a storage description (#37) ─────────────
// Reapply puts the server back in line with a volume's description: the
// mdadm.conf line, the array, the volume group, the fstab entry, the mount.
// It never creates, formats, wipes or adds anything. Accept rewrites the
// description from the server instead.

func descriptionFor(mountPoint string) (storageDescription, string, *fsError) {
	mp, fe := validMountPoint(mountPoint)
	if fe != nil {
		return storageDescription{}, "", fe
	}
	all, files := loadDescriptions()
	d, ok := all[mp]
	if !ok {
		return storageDescription{}, "", &fsError{Code: "ENOENT", Message: "no storage description for " + mp}
	}
	return d, files[mp], nil
}

// minMembers is how many members an array needs to start.
func minMembers(level string, devices int) int {
	switch level {
	case "raid1":
		return 1
	case "raid4", "raid5":
		return devices - 1
	case "raid6":
		return devices - 2
	case "raid10":
		return (devices + 1) / 2
	}
	return devices
}

// arrayNameFor keeps the described name unless another array uses it.
func arrayNameFor(a *descArray, mdadmConf string) string {
	taken := map[string]bool{}
	for _, n := range hostMdNames() {
		taken[n] = true
	}
	for _, l := range splitConf(mdadmConf) {
		if dev, u := arrayLineFields(strings.TrimSpace(l)); dev != "" && u != a.UUID {
			taken[filepath.Base(dev)] = true
		}
	}
	if reMdDev.MatchString(a.Name) && !taken[a.Name] {
		return a.Name
	}
	var used []string
	for n := range taken {
		used = append(used, n)
	}
	return nextMdName(used, "")
}

func planStorageReapply(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		MountPoint string `json:"mountPoint"`
		Degraded   bool   `json:"degraded"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	d, file, fe := descriptionFor(req.MountPoint)
	if fe != nil {
		return nil, fe
	}
	mp := d.Mount.Point
	l := collectLiveFn(d)
	rawDesc, _ := os.ReadFile(file)
	fstab, mdConf := readFstab(), readMdadmConf()
	obs := map[string]string{"description": string(rawDesc), "fstab": fstab, "mdadm.conf": mdConf,
		"array": l.ArrayDev, "mountedOn": l.MountedOn, "vgActive": fmt.Sprint(l.VGActive)}

	if l.MountedOn != "" && l.MountedOn != mp {
		return nil, &fsError{Code: "EBUSY", Message: "The filesystem is mounted on " + l.MountedOn + "; unmount it first"}
	}
	if l.MountedOn == "" && l.MountPointUUID != "" {
		return nil, &fsError{Code: "EBUSY", Message: "Another filesystem (" + l.MountPointUUID + ") is mounted on " + mp + "; unmount it first"}
	}
	arrayUp := d.Array == nil || l.ArrayDev != ""
	vgUp := d.LVM == nil || l.VGActive
	if arrayUp && vgUp && len(l.FSDevices) == 0 {
		return nil, &fsError{Code: "ENOFS", Message: "The filesystem " + d.Filesystem.UUID + " is not on any connected disk"}
	}
	if len(l.FSDevices) > 1 && hostBlkid(l.FSDevices[0], "TYPE") != "btrfs" {
		return nil, &fsError{Code: "ERR", Message: "several devices carry the filesystem " + d.Filesystem.UUID + " (" + strings.Join(l.FSDevices, ", ") + "), a clone or a snapshot: disconnect the copy"}
	}

	var steps []planStep
	if a := d.Array; a != nil {
		name := l.ArrayDev
		if name == "" {
			name = arrayNameFor(a, mdConf)
		}
		raidDev := "/dev/" + name
		if l.ArrayDev == "" {
			var present, missing []string
			for _, k := range d.Disks {
				if k.Role != "active" && k.Role != "spare" {
					continue
				}
				if l.Connected[k.Serial] {
					present = append(present, k.ByID)
				} else if k.Role == "active" {
					missing = append(missing, k.Serial)
				}
			}
			activePresent := 0
			for _, k := range d.Disks {
				if k.Role == "active" && l.Connected[k.Serial] {
					activePresent++
				}
			}
			if need := minMembers(a.Level, a.Devices); activePresent < need {
				return nil, &fsError{Code: "EMISSING", Message: fmt.Sprintf("%s needs at least %d of its %d disks to start; connect %s", name, need, a.Devices, strings.Join(missing, ", "))}
			}
			args := []string{"mdadm", "--assemble", raidDev, "--uuid=" + a.UUID}
			summary := "Assemble the array " + a.UUID + " as " + raidDev + " from its described disks, without changing its data"
			if len(missing) > 0 {
				if !req.Degraded {
					return nil, &fsError{Code: "EDEGRADED", Message: "Start " + name + " without " + strings.Join(missing, ", ") + ": it has no redundancy until a disk is added"}
				}
				args = append(args, "--run")
				summary += ", degraded"
			}
			steps = append(steps, cmdStep(raidDev, summary, append(args, present...)))
		}
		if !l.MdadmConfHasArray {
			s := planStep{Kind: "update", Target: mdadmConfPath, OnFailure: "warn",
				Summary: "Add the ARRAY line of " + raidDev + " to mdadm.conf so it assembles under the same name at boot"}
			edit := func(line string) func(string) string {
				return func(conf string) string { return upsertArrayLine(conf, name, line) }
			}
			if l.ArrayDev != "" {
				brief, _ := hostMdBrief(raidDev)
				line := briefArrayLine(brief)
				s.Diff = unifiedDiff(mdadmConfPath, mdConf, edit(line)(mdConf))
				s.run = func() (string, error) { return "", editMdadmConf(edit(line)) }
			} else {
				s.Deferred = true
				s.run = func() (string, error) {
					brief, err := hostMdBrief(raidDev)
					line := briefArrayLine(brief)
					if line == "" {
						return "", fmt.Errorf("could not read the array definition: %s", cmdErrMessage([]byte(brief), err))
					}
					before := readMdadmConf()
					if err := editMdadmConf(edit(line)); err != nil {
						return "", err
					}
					return unifiedDiff(mdadmConfPath, before, readMdadmConf()), nil
				}
			}
			steps = append(steps, s)
			if s, ok := initramfsStep(); ok {
				steps = append(steps, s)
			}
		}
	}
	if d.LVM != nil && !l.VGActive {
		steps = append(steps, cmdStep(d.LVM.VG, "Activate the volume group "+d.LVM.VG, []string{"vgchange", "-ay", d.LVM.VG}))
	}
	if !l.FstabPresent || l.FstabUUID != d.Filesystem.UUID || l.FstabOptions != d.Mount.Options {
		source := "UUID=" + d.Filesystem.UUID
		entry := fmt.Sprintf("%s\t%s\t%s\t%s\t0\t2", source, mp, d.Filesystem.Type, d.Mount.Options)
		s, err := fstabStep("Mount "+mp+" again at every boot, as described", fstab, func(conf string) (string, error) {
			return upsertFstabEntry(conf, mp, source, entry)
		})
		if err != nil {
			return nil, &fsError{Code: "ERR", Message: err.Error()}
		}
		steps = append(steps, s)
	}
	if l.MountedOn == "" {
		if !hostExists(mp) {
			steps = append(steps, planStep{Kind: "create", Target: mp, Summary: "Create the mount point directory " + mp,
				run: func() (string, error) { return "", os.MkdirAll(mp, 0o755) }})
		}
		steps = append(steps, cmdStep(mp, "Mount the filesystem "+d.Filesystem.UUID+" on "+mp,
			[]string{"mount", "-o", d.Mount.Options, "UUID=" + d.Filesystem.UUID, mp}))
	}
	if len(steps) == 0 {
		items := diffDescription(d, l)
		if len(items) == 0 {
			return nil, &fsError{Code: "ENOOP", Message: "The server already matches the description of " + mp}
		}
		var texts []string
		for _, i := range items {
			texts = append(texts, i.Text)
		}
		return nil, &fsError{Code: "ENOOP", Message: "Reapply does not change array members or levels (" + strings.Join(texts, "; ") + "). Accept the current state, or change the array from its page"}
	}
	return &opPlan{Op: "storage.reapply", Steps: steps, Observed: obs}, nil
}

func planStorageAccept(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		MountPoint string `json:"mountPoint"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	old, file, fe := descriptionFor(req.MountPoint)
	if fe != nil {
		return nil, fe
	}
	mp := old.Mount.Point
	next, fe := describeVolumeFn(mp, time.Now())
	if fe != nil {
		if fe.Code == "ENOTMOUNTED" {
			return nil, &fsError{Code: "ENOTMOUNTED", Message: "Mount " + mp + " first, or Reapply"}
		}
		return nil, fe
	}
	// The dates differ on every run: compare and show the rest.
	cmp := func(d storageDescription) string {
		d.Updated = time.Time{}
		b, _ := marshalDescription(d)
		return string(b)
	}
	if cmp(old) == cmp(next) {
		return nil, &fsError{Code: "ENOOP", Message: "The description of " + mp + " already matches the server"}
	}
	current, _ := os.ReadFile(file)
	after, _ := marshalDescription(next)
	step := planStep{Kind: "update", Target: file, Summary: "Describe " + mp + " as it is now on the server",
		Diff: unifiedDiff(file, string(current), string(after)),
		run: func() (string, error) {
			_, err := saveDescription(next)
			return "", err
		}}
	return &opPlan{Op: "storage.accept", Steps: []planStep{step}, Observed: map[string]string{"description": string(current), "server": cmp(next)}}, nil
}
