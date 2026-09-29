package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ── Plan builders: RAID member replacement and import (#36) ─────────────────

var (
	hostDeviceSize   = deviceSize
	hostActiveArrays = activeArrayUUIDs
)

// arrayIdentity reads the members and UUID of an array. Only these are
// observed: mdadm --detail also reports resync progress and event counts,
// which change on their own.
func arrayIdentity(name string) ([]string, string, *fsError) {
	out, err := hostMdDetail("/dev/" + name)
	if err != nil {
		return nil, "", &fsError{Code: "ERR", Message: cmdErrMessage([]byte(out), err)}
	}
	members, uuid := parseMdDetail(out)
	return members, uuid, nil
}

func sortedJoin(xs []string) string {
	s := append([]string(nil), xs...)
	sort.Strings(s)
	return strings.Join(s, " ")
}

func planRaidMember(raw json.RawMessage, op string) (*opPlan, *fsError) {
	var req raidMemberReq
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reMdDev.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid RAID name"}
	}
	if !reBlockDev.MatchString(req.Device) {
		return nil, &fsError{Code: "ERR", Message: "invalid device name"}
	}
	sys := hostSystemDevs()
	if sys[req.Name] && op != "--add" {
		return nil, &fsError{Code: "ESYS", Message: "cannot change members of the system RAID array from HSI"}
	}
	members, uuid, fe := arrayIdentity(req.Name)
	if fe != nil {
		return nil, fe
	}
	raidDev := "/dev/" + req.Name
	target := "/dev/" + req.Device
	obs := map[string]string{"members": sortedJoin(members), "uuid": uuid}
	var step planStep
	switch op {
	case "--fail", "--remove":
		if !isMember(members, req.Device) {
			return nil, &fsError{Code: "ERR", Message: target + " is not a member of " + raidDev}
		}
		// A disk that was unplugged or died completely has no device node:
		// mdadm addresses it as "detached".
		arg := target
		if op == "--remove" && !hostExists(target) {
			arg = "detached"
		}
		obs["target"] = arg
		summary := "Mark " + target + " as failed in " + raidDev + "; the array keeps running without it until a replacement is added"
		if op == "--remove" {
			summary = "Remove " + target + " from " + raidDev
			if arg == "detached" {
				summary = "Remove the disks that are no longer connected from " + raidDev
			}
		}
		step = cmdStep(raidDev, summary, []string{"mdadm", "--manage", raidDev, op, arg})
	case "--add":
		if isMember(members, req.Device) {
			return nil, &fsError{Code: "ERR", Message: target + " is already a member of " + raidDev}
		}
		if sys[req.Device] {
			return nil, &fsError{Code: "ESYS", Message: target + " belongs to the system disk"}
		}
		if fe := hostClaimable(req.Device); fe != nil {
			return nil, fe
		}
		var sizes []int64
		for _, m := range members {
			if s, err := hostDeviceSize(m); err == nil {
				sizes = append(sizes, s)
			}
		}
		size, err := hostDeviceSize(target)
		if err != nil {
			return nil, &fsError{Code: "ERR", Message: "could not read the size of " + target + ": " + err.Error()}
		}
		if p := replacementSizeProblem(req.Device, size, sizes); p != "" {
			return nil, &fsError{Code: "ERR", Message: p}
		}
		observeDevice(obs, "target", target)
		step = destructive(cmdStep(raidDev, "Add "+target+" to "+raidDev+", erasing its contents; a degraded array rebuilds onto it, otherwise it becomes a spare",
			[]string{"mdadm", "--manage", raidDev, "--add", target}), target)
	}
	return &opPlan{Op: "raid." + strings.TrimPrefix(op, "--"), Steps: []planStep{step}, Observed: obs}, nil
}

func planRaidFail(raw json.RawMessage) (*opPlan, *fsError)   { return planRaidMember(raw, "--fail") }
func planRaidRemove(raw json.RawMessage) (*opPlan, *fsError) { return planRaidMember(raw, "--remove") }
func planRaidAdd(raw json.RawMessage) (*opPlan, *fsError)    { return planRaidMember(raw, "--add") }

func planImportAssemble(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		UUID          string `json:"uuid"`
		Name          string `json:"name"`
		AllowDegraded bool   `json:"allowDegraded"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reUUID.MatchString(req.UUID) || !reMdDev.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid request"}
	}
	active := hostActiveArrays()
	if active[req.UUID] {
		return nil, &fsError{Code: "EEXIST", Message: "this array is already running"}
	}
	var running []string
	for u := range active {
		running = append(running, u)
	}
	raidDev := "/dev/" + req.Name
	args := []string{"mdadm", "--assemble", raidDev, "--uuid=" + req.UUID, "--scan"}
	summary := "Assemble the existing array " + req.UUID + " as " + raidDev + " without changing its data"
	if req.AllowDegraded {
		args = append(args, "--run")
		summary = "Assemble the existing array " + req.UUID + " as " + raidDev + " and start it even though members are missing (degraded)"
	}
	steps := []planStep{cmdStep(raidDev, summary, args)}
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
	obs := map[string]string{"active": sortedJoin(running), "mdadm.conf": readMdadmConf()}
	return &opPlan{Op: "import.assemble", Steps: steps, Observed: obs, Reply: map[string]any{"device": raidDev}}, nil
}

func planImportActivate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reImportVGName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid volume group name"}
	}
	s := cmdStep(req.Name, "Activate the logical volumes of the existing volume group "+req.Name+" without changing its data",
		[]string{"vgchange", "-ay", req.Name})
	return &opPlan{Op: "import.activate", Steps: []planStep{s}, Observed: map[string]string{}}, nil
}
