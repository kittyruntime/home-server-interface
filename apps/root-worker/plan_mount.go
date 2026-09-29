package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ── Plan builders: mount and unmount (#36) ───────────────────────────────────

var (
	hostExists = func(p string) bool { _, err := os.Stat(p); return err == nil }
	hostBlkid  = func(dev, tag string) string {
		o, _ := hostOutput("blkid", "-s", tag, "-o", "value", dev)
		return strings.TrimSpace(string(o))
	}
	hostMountSources = mountSources
	hostPrepareRoot  = prepareVolumeRoot
)

func readFstab() string {
	b, _ := hostReadFile(fstabPath)
	return string(b)
}

// fstabStep previews an fstab edit as a diff against the current file and
// applies the same edit when it runs.
func fstabStep(summary string, current string, edit func(string) (string, error)) (planStep, error) {
	next, err := edit(current)
	if err != nil {
		return planStep{}, err
	}
	return planStep{Kind: "update", Target: fstabPath, Summary: summary, Diff: unifiedDiff(fstabPath, current, next),
		run: func() (string, error) { return "", editFstab(edit) }}, nil
}

func validMountPoint(raw string) (string, *fsError) {
	mp := filepath.Clean(raw)
	if !filepath.IsAbs(mp) || strings.Contains(mp, "..") {
		return "", &fsError{Code: "ERR", Message: "invalid mount point path"}
	}
	// Reject fstab structural characters: newline/CR/tab would inject extra
	// fstab lines; space and # break field parsing / start comments.
	if strings.ContainsAny(mp, "\n\r\t #") {
		return "", &fsError{Code: "ERR", Message: "mount point contains invalid characters"}
	}
	return mp, nil
}

func planMount(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Device     string `json:"device"`
		MountPoint string `json:"mountpoint"`
		Options    string `json:"options"`
		Persist    bool   `json:"persist"`
		// Access "shared" or "user" prepares a fresh volume for OwnerUser and
		// the hsi-share group; Force also applies it to a volume that already
		// holds data, once the admin has confirmed.
		Access    string `json:"access"`
		OwnerUser string `json:"ownerUser"`
		Force     bool   `json:"force"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reBlockDev.MatchString(req.Device) {
		return nil, &fsError{Code: "ERR", Message: "invalid device name"}
	}
	mp, fe := validMountPoint(req.MountPoint)
	if fe != nil {
		return nil, fe
	}
	if criticalMountPoints[mp] {
		return nil, &fsError{Code: "ESYS", Message: "cannot mount over system directory " + mp}
	}
	devPath := "/dev/" + req.Device
	if member, reason := hostMemberOf(req.Device); member {
		return nil, &fsError{Code: "EBUSY", Message: reason}
	}
	opts := req.Options
	if opts == "" {
		opts = "defaults"
	}
	if strings.ContainsAny(opts, "\n\r\t #") {
		return nil, &fsError{Code: "ERR", Message: "mount options contain invalid characters"}
	}

	obs := map[string]string{}
	observeDevice(obs, "device", devPath)
	var steps []planStep
	if !hostExists(mp) {
		steps = append(steps, planStep{Kind: "create", Target: mp, Summary: "Create the mount point directory " + mp,
			run: func() (string, error) { return "", os.MkdirAll(mp, 0755) }})
	}
	if req.Persist {
		// Immutable while empty: if the volume is ever missing, nothing can
		// write to the boot disk in its place (#3).
		s := cmdStep(mp, "Protect "+mp+" so nothing is written to the system disk when the volume is missing", []string{"chattr", "+i", mp})
		s.OnFailure = "warn"
		steps = append(steps, s)
	}
	steps = append(steps, cmdStep(mp, "Mount "+devPath+" on "+mp, []string{"mount", "-o", opts, devPath, mp}))
	if req.Persist {
		uuid := hostBlkid(devPath, "UUID")
		fstype := hostBlkid(devPath, "TYPE")
		if fstype == "" {
			fstype = "auto"
		}
		source := devPath
		if uuid != "" {
			source = "UUID=" + uuid
		}
		entry := fmt.Sprintf("%s\t%s\t%s\t%s\t0\t2", source, mp, fstype, withBootOptions(opts))
		current := readFstab()
		obs["fstab"] = current
		s, err := fstabStep("Mount "+mp+" again at every boot", current, func(conf string) (string, error) {
			return upsertFstabEntry(conf, mp, source, entry)
		})
		if err != nil {
			// Refused before anything runs (it used to fail after mounting).
			return nil, &fsError{Code: "ERR", Message: err.Error()}
		}
		base := s.run
		s.run = func() (string, error) {
			if _, err := base(); err != nil {
				// The mount itself succeeded: say only persistence failed.
				return "", fmt.Errorf("mounted on %s, but not saved for reboot: %v", mp, err)
			}
			return "", nil
		}
		s.failCode = "EPERSIST"
		steps = append(steps, s)
	}
	if req.Access == "shared" || req.Access == "user" {
		who := "the hsi-share group"
		if req.OwnerUser != "" {
			who = req.OwnerUser + " and the hsi-share group"
		}
		steps = append(steps, planStep{Kind: "permissions", Target: mp, Summary: "Make " + mp + " writable by " + who, OnFailure: "warn",
			run: func() (string, error) {
				if ws := hostPrepareRoot(mp, req.OwnerUser, req.Force); len(ws) > 0 {
					return "", errors.New(strings.Join(ws, "; "))
				}
				return "", nil
			}})
	}
	return &opPlan{Op: "mount", Steps: steps, Observed: obs}, nil
}

func planUmount(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		MountPoint      string `json:"mountpoint"`
		RemoveFromFstab bool   `json:"removeFromFstab"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	mp := filepath.Clean(req.MountPoint)
	if !filepath.IsAbs(mp) || strings.Contains(mp, "..") {
		return nil, &fsError{Code: "ERR", Message: "invalid mount point"}
	}
	if criticalMountPoints[mp] {
		return nil, &fsError{Code: "ESYS", Message: "cannot unmount system directory"}
	}
	// Identify what is mounted here, so only the fstab entry for that device
	// is removed (never an admin entry for another one).
	sources := hostMountSources(mp)
	obs := map[string]string{"sources": strings.Join(sources, " ")}
	steps := []planStep{cmdStep(mp, "Unmount "+mp, []string{"umount", mp})}
	if req.RemoveFromFstab {
		current := readFstab()
		obs["fstab"] = current
		s, _ := fstabStep("Stop mounting "+mp+" at boot", current, func(conf string) (string, error) {
			return removeFstabLines(conf, mp, sources...), nil
		})
		base := s.run
		s.run = func() (string, error) {
			if _, err := base(); err != nil {
				return "", fmt.Errorf("unmounted %s, but its fstab entry was not removed: %v", mp, err)
			}
			return "", nil
		}
		s.failCode = "EPERSIST"
		unprotect := cmdStep(mp, "Make "+mp+" an ordinary directory again", []string{"chattr", "-i", mp})
		unprotect.OnFailure = "warn"
		steps = append(steps, s, unprotect)
	}
	return &opPlan{Op: "umount", Steps: steps, Observed: obs}, nil
}
