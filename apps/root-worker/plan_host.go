package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Host reads used by plan builders. Tests replace them to build plans from
// fixtures without touching the machine.
var (
	hostProcMounts = func() string { b, _ := os.ReadFile("/proc/mounts"); return string(b) }
	hostSystemDevs = systemDeviceNames
	hostMemberOf   = isRaidOrLvmMember
	hostClaimable  = checkDeviceClaimable
	hostLookPath   = func(name string) bool { _, err := exec.LookPath(name); return err == nil }
	hostReadFile   = os.ReadFile
	hostDescribe   = describeDevice
	hostSignatures = func(dev string) string { o, _ := command("wipefs", "-n", "-J", dev).Output(); return string(o) }
	hostMdDetail   = func(dev string) (string, error) {
		o, err := command("mdadm", "--detail", dev).CombinedOutput()
		return string(o), err
	}
	hostOutput = func(name string, args ...string) ([]byte, error) { return command(name, args...).Output() }
)

func isMountedSource(procMounts string, sources ...string) bool {
	for _, line := range strings.Split(procMounts, "\n") {
		if f := strings.Fields(line); len(f) > 0 && containsString(sources, f[0]) {
			return true
		}
	}
	return false
}

// describeDevice names a device the way a person can recognise it: model,
// serial, size and what it currently holds.
// A partition has no model or serial of its own: they come from its disk.
func describeDevice(dev string) *deviceInfo {
	out, err := hostOutput("lsblk", "-J", "-b", "-o", "PATH,MODEL,SERIAL,SIZE,FSTYPE,LABEL", dev)
	if err != nil {
		return &deviceInfo{Path: dev}
	}
	d := parseLsblkDevice(out)
	if d.Path == "" {
		d.Path = dev
	}
	if d.Model == "" && d.Serial == "" {
		if pk, err := hostOutput("lsblk", "-no", "PKNAME", dev); err == nil {
			if parent := strings.TrimSpace(strings.SplitN(string(pk), "\n", 2)[0]); parent != "" {
				if pout, err := hostOutput("lsblk", "-J", "-b", "-o", "PATH,MODEL,SERIAL,SIZE,FSTYPE,LABEL", "/dev/"+parent); err == nil {
					p := parseLsblkDevice(pout)
					d.Model, d.Serial = p.Model, p.Serial
				}
			}
		}
	}
	return &d
}

type lsblkNode struct {
	Path     string      `json:"path"`
	Model    *string     `json:"model"`
	Serial   *string     `json:"serial"`
	Size     int64       `json:"size"`
	FSType   *string     `json:"fstype"`
	Label    *string     `json:"label"`
	Children []lsblkNode `json:"children"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

func fsDescription(n lsblkNode) string {
	switch fs := str(n.FSType); fs {
	case "":
		return ""
	case "linux_raid_member":
		return "RAID member"
	case "LVM2_member":
		return "LVM physical volume"
	default:
		if l := str(n.Label); l != "" {
			return fmt.Sprintf("%s %q", fs, l)
		}
		return fs
	}
}

func parseLsblkDevice(raw []byte) deviceInfo {
	var doc struct {
		Blockdevices []lsblkNode `json:"blockdevices"`
	}
	if json.Unmarshal(raw, &doc) != nil || len(doc.Blockdevices) == 0 {
		return deviceInfo{}
	}
	n := doc.Blockdevices[0]
	d := deviceInfo{Path: n.Path, Model: str(n.Model), Serial: str(n.Serial), Size: n.Size}
	switch {
	case len(n.Children) > 0:
		var parts []string
		for _, c := range n.Children {
			if f := fsDescription(c); f != "" {
				parts = append(parts, f)
			}
		}
		noun := "partitions"
		if len(n.Children) == 1 {
			noun = "partition"
		}
		d.Contents = fmt.Sprintf("%d %s", len(n.Children), noun)
		if len(parts) > 0 {
			d.Contents += ": " + strings.Join(parts, ", ")
		}
	case fsDescription(n) != "":
		d.Contents = fsDescription(n)
	default:
		d.Contents = "no filesystem"
	}
	return d
}

// devPathFor returns the node of a device named as lsblk names it: a logical
// volume or a mapping is "vg-lv", whose node is /dev/mapper/vg-lv.
func devPathFor(name string) string {
	if p := "/dev/" + name; hostExists(p) || strings.Contains(name, "/") {
		return p
	}
	if p := "/dev/mapper/" + name; hostExists(p) {
		return p
	}
	return "/dev/" + name
}
