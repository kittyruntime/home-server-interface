package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ── Plan builders: RAID create and stop (#36) ────────────────────────────────

var hostMdBrief = func(dev string) (string, error) {
	o, err := command("mdadm", "--detail", "--brief", dev).CombinedOutput()
	return string(o), err
}

func readMdadmConf() string {
	b, _ := hostReadFile(mdadmConfPath)
	return string(b)
}

// initramfsStep refreshes the initramfs after an mdadm.conf change, so the
// array keeps its name at boot (otherwise it may come back as md127).
func initramfsStep() (planStep, bool) {
	if !hostLookPath("update-initramfs") {
		return planStep{}, false
	}
	s := cmdStep("initramfs", "Refresh the initramfs so the array keeps its name at boot", []string{"update-initramfs", "-u"})
	s.OnFailure = "warn"
	return s, true
}

func planRaidCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name    string   `json:"name"`
		Level   int      `json:"level"`
		Devices []string `json:"devices"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reMdDev.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid RAID name; must be md0, md1, ... md999"}
	}
	minDev := map[int]int{0: 2, 1: 2, 5: 3, 10: 4}
	required, ok := minDev[req.Level]
	if !ok {
		return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("unsupported RAID level %d", req.Level)}
	}
	if len(req.Devices) < required {
		return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("RAID %d needs at least %d devices (got %d)", req.Level, required, len(req.Devices))}
	}
	if !hostLookPath("mdadm") {
		return nil, &fsError{Code: "ENOTOOL", Message: "mdadm is not installed; install it with: sudo apt install mdadm"}
	}
	sys := hostSystemDevs()
	obs := map[string]string{"mdadm.conf": readMdadmConf()}
	devPaths := make([]string, 0, len(req.Devices))
	for _, d := range req.Devices {
		if !reBlockDev.MatchString(d) {
			return nil, &fsError{Code: "ERR", Message: "invalid device name: " + d}
		}
		if sys[d] {
			return nil, &fsError{Code: "ESYS", Message: "device " + d + " belongs to the system disk"}
		}
		if fe := hostClaimable(d); fe != nil {
			return nil, fe
		}
		devPaths = append(devPaths, "/dev/"+d)
		observeDevice(obs, "/dev/"+d, "/dev/"+d)
	}
	raidDev := "/dev/" + req.Name
	args := append([]string{"mdadm", "--create", raidDev, "--level", fmt.Sprintf("%d", req.Level),
		"--raid-devices", fmt.Sprintf("%d", len(devPaths)), "--run"}, devPaths...)
	create := cmdStep(raidDev, fmt.Sprintf("Create RAID %d array %s from %s, erasing their contents", req.Level, raidDev, strings.Join(devPaths, ", ")), args)
	steps := []planStep{destructive(create, devPaths[0])}

	// The ARRAY line carries the UUID mdadm assigns at creation: its exact
	// content is only known once the array exists.
	steps = append(steps, planStep{Kind: "update", Target: mdadmConfPath, Deferred: true, OnFailure: "warn",
		Summary: "Add the ARRAY line of " + raidDev + " to mdadm.conf so it assembles under the same name at boot",
		run: func() (string, error) {
			brief, err := hostMdBrief(raidDev)
			line := briefArrayLine(brief)
			if line == "" {
				return "", fmt.Errorf("could not read the array definition: %s", cmdErrMessage([]byte(brief), err))
			}
			before := readMdadmConf()
			if err := editMdadmConf(func(conf string) string { return upsertArrayLine(conf, req.Name, line) }); err != nil {
				return "", err
			}
			return unifiedDiff(mdadmConfPath, before, readMdadmConf()), nil
		}})
	if s, ok := initramfsStep(); ok {
		steps = append(steps, s)
	}
	return &opPlan{Op: "raid.create", Steps: steps, Observed: obs, Reply: map[string]any{"device": raidDev}}, nil
}

func planRaidStop(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reMdDev.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid RAID name"}
	}
	if hostSystemDevs()[req.Name] {
		return nil, &fsError{Code: "ESYS", Message: "cannot destroy system RAID array"}
	}
	raidDev := "/dev/" + req.Name
	if isMountedSource(hostProcMounts(), raidDev) {
		return nil, &fsError{Code: "EMNT", Message: "RAID array is mounted; unmount it first"}
	}
	// Members and UUID are read before stopping: without them the superblocks
	// cannot be wiped and the array comes back at the next boot.
	detail, derr := hostMdDetail(raidDev)
	members, uuid := parseMdDetail(detail)
	if derr != nil || len(members) == 0 {
		return nil, &fsError{Code: "ERR", Message: "could not read the members of " + raidDev + ": " + cmdErrMessage([]byte(detail), derr)}
	}
	fstabSources := []string{raidDev}
	if v := hostBlkid(raidDev, "UUID"); v != "" {
		fstabSources = append(fstabSources, "UUID="+v)
	}
	obs := map[string]string{"detail": detail, "fstab": readFstab(), "mdadm.conf": readMdadmConf()}

	steps := []planStep{cmdStep(raidDev, "Stop the RAID array "+raidDev, []string{"mdadm", "--stop", raidDev})}
	for _, m := range members {
		z := destructive(cmdStep(m, "Erase the RAID signature on "+m+" so it can be reused", []string{"mdadm", "--zero-superblock", m}), m)
		z.OnFailure = "warn"
		steps = append(steps, z)
	}
	if fs, _ := fstabStep("Stop mounting "+raidDev+" at boot", obs["fstab"], func(conf string) (string, error) {
		return removeFstabSources(conf, fstabSources...), nil
	}); fs.Diff != "" {
		fs.OnFailure = "warn"
		steps = append(steps, fs)
	}
	before := obs["mdadm.conf"]
	edit := func(conf string) string { return removeArrayEntries(conf, req.Name, uuid) }
	if after := edit(before); after != before {
		steps = append(steps, planStep{Kind: "update", Target: mdadmConfPath, OnFailure: "warn",
			Summary: "Remove " + raidDev + " from mdadm.conf", Diff: unifiedDiff(mdadmConfPath, before, after),
			run: func() (string, error) { return "", editMdadmConf(edit) }})
		if s, ok := initramfsStep(); ok {
			steps = append(steps, s)
		}
	}
	return &opPlan{Op: "raid.stop", Steps: steps, Observed: obs}, nil
}
