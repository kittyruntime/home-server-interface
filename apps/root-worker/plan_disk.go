package main

import (
	"encoding/json"
	"fmt"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// ── Plan builders: format, partitions, LVM (#36) ─────────────────────────────
// Each builder performs the checks its handler used to do (same codes), reads
// the state it depends on into Observed, and returns the steps. Nothing runs
// while building.

var hostLvs = func() []lvmLV { _, _, lvs := getLvmInfo(); return lvs }

func badRequest(err error) *fsError {
	return &fsError{Code: "ERR", Message: "bad request: " + err.Error()}
}

// settleSteps tells the kernel and udev about a changed device; best effort.
func settleSteps(devPath string) []planStep {
	probe := cmdStep(devPath, "Re-read the partition table of "+devPath, []string{"partprobe", devPath})
	probe.OnFailure = "ignore"
	settle := cmdStep("udev", "Wait for udev to settle", []string{"udevadm", "settle"})
	settle.OnFailure = "ignore"
	return []planStep{probe, settle}
}

func destructive(s planStep, dev string) planStep {
	s.Destructive = true
	s.Device = hostDescribe(dev)
	return s
}

func observeDevice(obs map[string]string, key, dev string) {
	obs[key+":signatures"] = hostSignatures(dev)
	if d := hostDescribe(dev); d != nil {
		b, _ := json.Marshal(d)
		obs[key+":device"] = string(b)
	}
}

func planFormat(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Device string `json:"device"`
		FsType string `json:"fstype"`
		Label  string `json:"label"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reBlockDev.MatchString(req.Device) {
		return nil, &fsError{Code: "ERR", Message: "invalid device name"}
	}
	if hostSystemDevs()[req.Device] {
		return nil, &fsError{Code: "ESYS", Message: "cannot format system device; it is in use by the OS"}
	}
	devPath := "/dev/" + req.Device
	if isMountedSource(hostProcMounts(), devPath) {
		return nil, &fsError{Code: "EMNT", Message: "device is mounted; unmount it first"}
	}
	if member, reason := hostMemberOf(req.Device); member {
		return nil, &fsError{Code: "EMEMBER", Message: reason + "; remove it from the array/volume group first"}
	}
	label := strings.TrimSpace(req.Label)
	var args []string
	switch req.FsType {
	case "ext4":
		args = []string{"mkfs.ext4", "-F"}
		if label != "" {
			args = append(args, "-L", label)
		}
	case "xfs":
		args = []string{"mkfs.xfs", "-f"}
		if label != "" {
			args = append(args, "-L", label)
		}
	case "btrfs":
		args = []string{"mkfs.btrfs", "-f"}
		if label != "" {
			args = append(args, "-L", label)
		}
	case "fat32", "vfat":
		// Prefer mkfs.fat (newer name); fall back to mkfs.vfat.
		bin := "mkfs.fat"
		if !hostLookPath(bin) {
			bin = "mkfs.vfat"
		}
		args = []string{bin, "-F", "32"}
		if label != "" {
			l := label
			if len(l) > 11 {
				l = l[:11]
			}
			args = append(args, "-n", strings.ToUpper(l))
		}
	default:
		return nil, &fsError{Code: "ERR", Message: "unsupported filesystem: " + req.FsType}
	}
	args = append(args, devPath)
	obs := map[string]string{"signatures": hostSignatures(devPath)}
	observeDevice(obs, "target", devPath)
	fsName := req.FsType
	if fsName == "vfat" {
		fsName = "fat32"
	}
	steps := []planStep{destructive(cmdStep(devPath, "Create a new "+fsName+" filesystem on "+devPath+", erasing its contents", args), devPath)}
	steps = append(steps, settleSteps(devPath)...)
	return &opPlan{Op: "format", Steps: steps, Observed: obs}, nil
}

func planPartInit(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Device string `json:"device"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reBlockDev.MatchString(req.Device) {
		return nil, &fsError{Code: "ERR", Message: "invalid device name"}
	}
	if hostSystemDevs()[req.Device] {
		return nil, &fsError{Code: "ESYS", Message: "cannot modify system disk"}
	}
	if member, reason := hostMemberOf(req.Device); member {
		return nil, &fsError{Code: "EMEMBER", Message: reason + "; remove it from the array/volume group first"}
	}
	devPath := "/dev/" + req.Device
	obs := map[string]string{}
	observeDevice(obs, "disk", devPath)
	steps := []planStep{destructive(cmdStep(devPath, "Write a new empty GPT partition table on "+devPath+", removing every partition on it",
		[]string{"parted", "-s", devPath, "mklabel", "gpt"}), devPath)}
	steps = append(steps, settleSteps(devPath)...)
	return &opPlan{Op: "part.init", Steps: steps, Observed: obs}, nil
}

func planPartCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Device   string `json:"device"`
		StartPct int    `json:"startPct"`
		EndPct   int    `json:"endPct"` // 0 = 100%
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reBlockDev.MatchString(req.Device) {
		return nil, &fsError{Code: "ERR", Message: "invalid device name"}
	}
	if hostSystemDevs()[req.Device] {
		return nil, &fsError{Code: "ESYS", Message: "cannot modify system disk"}
	}
	if member, reason := hostMemberOf(req.Device); member {
		return nil, &fsError{Code: "EBUSY", Message: reason}
	}
	end := req.EndPct
	if end == 0 {
		end = 100
	}
	if req.StartPct < 0 || end > 100 || req.StartPct >= end {
		return nil, &fsError{Code: "ERR", Message: "invalid start/end percentages"}
	}
	devPath := "/dev/" + req.Device
	obs := map[string]string{}
	observeDevice(obs, "disk", devPath)
	steps := []planStep{cmdStep(devPath, fmt.Sprintf("Add a partition on %s from %d%% to %d%% of the disk", devPath, req.StartPct, end),
		[]string{"parted", "-s", devPath, "mkpart", "primary", fmt.Sprintf("%d%%", req.StartPct), fmt.Sprintf("%d%%", end)})}
	steps = append(steps, settleSteps(devPath)...)
	return &opPlan{Op: "part.create", Steps: steps, Observed: obs}, nil
}

func planPartDelete(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Device  string `json:"device"`
		PartNum string `json:"partNum"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reBlockDev.MatchString(req.Device) || !rePartNum.MatchString(req.PartNum) {
		return nil, &fsError{Code: "ERR", Message: "invalid device or partition number"}
	}
	base := req.Device
	partDev := base + req.PartNum
	if strings.ContainsAny(base, "0123456789") && (strings.HasPrefix(base, "nvme") || strings.HasPrefix(base, "mmcblk")) {
		partDev = base + "p" + req.PartNum
	}
	sys := hostSystemDevs()
	if sys[req.Device] || sys[partDev] {
		return nil, &fsError{Code: "ESYS", Message: "cannot delete partition from system disk"}
	}
	if member, reason := hostMemberOf(partDev); member {
		return nil, &fsError{Code: "EMEMBER", Message: reason + "; remove it from the array/volume group first"}
	}
	partPath := "/dev/" + partDev
	if isMountedSource(hostProcMounts(), partPath) {
		return nil, &fsError{Code: "EMNT", Message: "partition is mounted; unmount it first"}
	}
	diskPath := "/dev/" + req.Device
	obs := map[string]string{}
	observeDevice(obs, "disk", diskPath)
	observeDevice(obs, "partition", partPath)
	steps := []planStep{destructive(cmdStep(partPath, "Delete partition "+partPath+" and everything on it",
		[]string{"parted", "-s", diskPath, "rm", req.PartNum}), partPath)}
	steps = append(steps, settleSteps(diskPath)...)
	return &opPlan{Op: "part.delete", Steps: steps, Observed: obs}, nil
}

func planPvCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Devices []string `json:"devices"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if len(req.Devices) == 0 {
		return nil, &fsError{Code: "ERR", Message: "no devices specified"}
	}
	sys := hostSystemDevs()
	obs := map[string]string{}
	devPaths := make([]string, 0, len(req.Devices))
	for _, d := range req.Devices {
		if !reBlockDev.MatchString(d) {
			return nil, &fsError{Code: "ERR", Message: "invalid device name: " + d}
		}
		if sys[d] {
			return nil, &fsError{Code: "ESYS", Message: d + " belongs to the system disk"}
		}
		if fe := hostClaimable(d); fe != nil {
			return nil, fe
		}
		devPaths = append(devPaths, "/dev/"+d)
		observeDevice(obs, "/dev/"+d, "/dev/"+d)
	}
	// -f skips pvcreate's own "signature detected, wipe it?" prompt; it is only
	// safe because hostClaimable refused anything holding data above.
	steps := []planStep{}
	s := cmdStep(strings.Join(devPaths, " "), "Make "+strings.Join(devPaths, ", ")+" LVM physical volumes, erasing their contents",
		append([]string{"pvcreate", "-f"}, devPaths...))
	steps = append(steps, destructive(s, devPaths[0]))
	return &opPlan{Op: "pv.create", Steps: steps, Observed: obs}, nil
}

func planVgCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name    string   `json:"name"`
		Devices []string `json:"devices"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reVGName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid VG name (letters, digits, _ - only)"}
	}
	sys := hostSystemDevs()
	devPaths := make([]string, 0, len(req.Devices))
	for _, d := range req.Devices {
		if !reBlockDev.MatchString(d) {
			return nil, &fsError{Code: "ERR", Message: "invalid device: " + d}
		}
		if sys[d] {
			return nil, &fsError{Code: "ESYS", Message: d + " is a system device"}
		}
		devPaths = append(devPaths, "/dev/"+d)
	}
	steps := []planStep{cmdStep(req.Name, "Create volume group "+req.Name+" on "+strings.Join(devPaths, ", "),
		append([]string{"vgcreate", req.Name}, devPaths...))}
	return &opPlan{Op: "vg.create", Steps: steps, Observed: map[string]string{}}, nil
}

func planLvCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		VGName    string `json:"vgName"`
		LVName    string `json:"lvName"`
		SizeBytes int64  `json:"sizeBytes"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reVGName.MatchString(req.VGName) || !reVGName.MatchString(req.LVName) {
		return nil, &fsError{Code: "ERR", Message: "invalid VG or LV name"}
	}
	args := []string{"lvcreate", "-l", "100%FREE", "-n", req.LVName, req.VGName}
	size := "all free space"
	if req.SizeBytes != 0 {
		args = []string{"lvcreate", "-L", fmt.Sprintf("%dB", req.SizeBytes), "-n", req.LVName, req.VGName}
		size = fmt.Sprintf("%d bytes", req.SizeBytes)
	}
	target := "/dev/" + req.VGName + "/" + req.LVName
	steps := []planStep{cmdStep(target, "Create logical volume "+target+" using "+size+" of "+req.VGName, args)}
	settle := cmdStep("udev", "Wait for udev to settle", []string{"udevadm", "settle"})
	settle.OnFailure = "ignore"
	steps = append(steps, settle)
	return &opPlan{Op: "lv.create", Steps: steps, Observed: map[string]string{}}, nil
}

func planLvRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		VGName string `json:"vgName"`
		LVName string `json:"lvName"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reVGName.MatchString(req.VGName) || !reVGName.MatchString(req.LVName) {
		return nil, &fsError{Code: "ERR", Message: "invalid VG or LV name"}
	}
	lvPath := "/dev/" + req.VGName + "/" + req.LVName
	if isMountedSource(hostProcMounts(), lvPath, lvDmPath(req.VGName, req.LVName)) {
		return nil, &fsError{Code: "EMNT", Message: "LV is mounted; unmount it first"}
	}
	obs := map[string]string{}
	observeDevice(obs, "lv", lvPath)
	steps := []planStep{destructive(cmdStep(lvPath, "Delete logical volume "+lvPath+" and everything on it", []string{"lvremove", "-f", lvPath}), lvPath)}
	return &opPlan{Op: "lv.remove", Steps: steps, Observed: obs}, nil
}

func planVgRemove(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		VGName string `json:"vgName"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !reVGName.MatchString(req.VGName) {
		return nil, &fsError{Code: "ERR", Message: "invalid VG name"}
	}
	mounts := hostProcMounts()
	var names []string
	for _, lv := range hostLvs() {
		if lv.VGName != req.VGName {
			continue
		}
		if isMountedSource(mounts, lv.Path, lvDmPath(lv.VGName, lv.Name)) {
			return nil, &fsError{Code: "EMNT", Message: "logical volume " + lv.Name + " is mounted; unmount it first"}
		}
		names = append(names, lv.Name)
	}
	summary := "Delete volume group " + req.VGName
	if len(names) > 0 {
		summary += " and its logical volumes (" + strings.Join(names, ", ") + ")"
	}
	s := cmdStep(req.VGName, summary, []string{"vgremove", "-f", req.VGName})
	s.Destructive = true
	return &opPlan{Op: "vg.remove", Steps: []planStep{s}, Observed: map[string]string{"lvs": strings.Join(names, ",")}}, nil
}

// servePlanOp runs an operation through its plan without a preview: the old
// root.sys.* subjects, kept for callers that do not use plans.
func servePlanOp(nc *nats.Conn, msg *nats.Msg, build func(json.RawMessage) (*opPlan, *fsError)) {
	p, fe := build(msg.Data)
	if fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	results, ok, warnings := p.execute()
	if !ok {
		for i, r := range results {
			if r.Status == "failed" {
				code := "ERR"
				if p.Steps[i].failCode != "" {
					code = p.Steps[i].failCode
				}
				replyErr(nc, msg.Reply, &fsError{Code: code, Message: r.Error})
				return
			}
		}
	}
	out := map[string]any{"ok": true}
	if len(warnings) > 0 {
		out["warnings"] = warnings
	}
	for k, v := range p.Reply {
		out[k] = v
	}
	replyOk(nc, msg.Reply, out)
}
