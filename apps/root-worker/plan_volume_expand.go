package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Plan builder: expand a data volume (#7) ──────────────────────────────────
// Four ways to grow an LVM volume in place, then its filesystem: the free
// space of its VG, a disk added to a volume without redundancy, a disk added
// to its RAID 5/6 array (reshape), the larger disks of its mirror. A reshape
// takes hours: its end (pvresize, lvextend, filesystem) is recorded as a
// pending expansion that finishExpansions completes later.

var (
	hostFSType     = func(dev string) string { return hostBlkid(dev, "TYPE") }
	hostSyncAction = func(md string) string {
		b, _ := os.ReadFile(filepath.Join("/sys/block", md, "md", "sync_action"))
		return strings.TrimSpace(string(b))
	}
	// component_size is in KiB: the space each member gives the array.
	hostComponentSize = func(md string) int64 {
		b, _ := os.ReadFile(filepath.Join("/sys/block", md, "md", "component_size"))
		n, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
		return n * 1024
	}
	// The array's size in bytes (/sys counts 512-byte sectors).
	hostArraySize = func(md string) int64 {
		b, _ := os.ReadFile(filepath.Join("/sys/block", md, "size"))
		n, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
		return n * 512
	}
	// The md name of an array by its UUID ("" if not running).
	hostArrayByUUID = func(uuid string) string {
		out, _ := hostOutput("mdadm", "--detail", "--scan")
		for _, l := range strings.Split(string(out), "\n") {
			if dev, u := arrayLineFields(strings.TrimSpace(l)); u == uuid && dev != "" {
				return filepath.Base(hostRealPath(dev))
			}
		}
		return ""
	}
	hostVgFree = func(vg string) int64 {
		out, _ := hostOutput("vgs", "--noheadings", "--nosuffix", "--units", "b", "-o", "vg_free", vg)
		n, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
		return n
	}
)

// pendingExpansion is an expansion waiting for its array's reshape or resync.
type pendingExpansion struct {
	UUID       string    `json:"uuid"`
	Array      string    `json:"array"`
	VG         string    `json:"vg"`
	LV         string    `json:"lv"`
	FSType     string    `json:"fstype"`
	MountPoint string    `json:"mountpoint"`
	StartedAt  time.Time `json:"startedAt"`
	Phase      string    `json:"phase"` // reshape | done | failed
	Error      string    `json:"error,omitempty"`
	NewSize    int64     `json:"newSize,omitempty"`
	// The array's identity and size before the grow: its end is told by a
	// larger size (an idle array after a reboot may not have resumed yet),
	// and its name can change at boot.
	ArrayUUID  string    `json:"arrayUuid,omitempty"`
	OldSize    int64     `json:"oldSize,omitempty"`
	Announced  bool      `json:"announced,omitempty"`
	FinishedAt time.Time `json:"finishedAt,omitempty"`
}

func expansionsPath() string { return envOr("HSI_EXPANSIONS", "/var/lib/hsi/expansions.json") }

func loadExpansions() []pendingExpansion {
	var list []pendingExpansion
	if b, err := os.ReadFile(expansionsPath()); err == nil {
		_ = json.Unmarshal(b, &list)
	}
	if list == nil {
		list = []pendingExpansion{}
	}
	return list
}

func saveExpansions(list []pendingExpansion) error { return saveJSON(expansionsPath(), list) }

// updateExpansions is the only read-modify-write of the file: writers wait
// for each other, so none loses another's entry.
func updateExpansions(edit func([]pendingExpansion) []pendingExpansion) error {
	lock, err := os.OpenFile(expansionsPath()+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return saveExpansions(edit(loadExpansions()))
}

func addPendingExpansion(p pendingExpansion) error {
	return updateExpansions(func(list []pendingExpansion) []pendingExpansion {
		for i := range list {
			if list[i].UUID == p.UUID {
				list[i] = p
				return list
			}
		}
		return append(list, p)
	})
}

// e2fsckStep checks an ext4 filesystem before an offline resize. Exit 1
// means it corrected errors: the filesystem is clean now.
func e2fsckStep(lvPath string) planStep {
	argv := []string{"e2fsck", "-f", "-p", lvPath}
	s := cmdStep(lvPath, "Check the filesystem before growing it", argv)
	s.run = func() (string, error) {
		out, err := runArgv(argv)
		if err != nil && !strings.HasSuffix(err.Error(), "exit status 1") {
			return "", cmdError{cmdErrMessage(out, err)}
		}
		return "", nil
	}
	return s
}

// growFsSteps grows a filesystem to its device: online for ext4, XFS and
// btrfs; an unmounted ext4 is checked, then grown offline.
func growFsSteps(fstype, lvPath, mp string, mounted bool) ([]planStep, *fsError) {
	switch fstype {
	case "ext4":
		if mounted {
			return []planStep{cmdStep(lvPath, "Grow the ext4 filesystem to the new size", []string{"resize2fs", lvPath})}, nil
		}
		return []planStep{
			e2fsckStep(lvPath),
			cmdStep(lvPath, "Grow the ext4 filesystem to the new size", []string{"resize2fs", lvPath}),
		}, nil
	case "xfs", "btrfs":
		if !mounted || mp == "" {
			return nil, &fsError{Code: "ERR", Message: "an " + strings.ToUpper(fstype) + " filesystem grows only while mounted: mount the volume first"}
		}
		if fstype == "xfs" {
			return []planStep{cmdStep(mp, "Grow the XFS filesystem to the new size", []string{"xfs_growfs", mp})}, nil
		}
		return []planStep{cmdStep(mp, "Grow the btrfs filesystem to the new size", []string{"btrfs", "filesystem", "resize", "max", mp})}, nil
	}
	return nil, &fsError{Code: "ERR", Message: "growing a " + fstype + " filesystem is not supported (ext4, XFS and btrfs are)"}
}

func planVolumeExpand(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		UUID string `json:"uuid"`
		Mode string `json:"mode"`
		Disk string `json:"disk"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	switch req.Mode {
	case "vgFree", "addDisk", "raidAddDisk", "mirrorGrow":
	default:
		return nil, &fsError{Code: "ERR", Message: "unknown expansion " + req.Mode}
	}
	if req.UUID == "" || strings.ContainsAny(req.UUID, " \t\n/") {
		return nil, &fsError{Code: "ERR", Message: "invalid volume id"}
	}
	for _, p := range loadExpansions() {
		if p.UUID == req.UUID && p.Phase == "reshape" {
			return nil, &fsError{Code: "EEXIST", Message: "an expansion of this volume is already under way"}
		}
	}
	devs := hostDevsByUUID(req.UUID)
	if len(devs) != 1 {
		return nil, &fsError{Code: "ENOENT", Message: "no single filesystem with UUID " + req.UUID + " on this server"}
	}
	dev := devs[0]
	var lv *lvmLV
	for _, l := range hostLvs() {
		if l.Path == dev || lvDmPath(l.VGName, l.Name) == dev {
			l := l
			lv = &l
		}
	}
	if lv == nil {
		return nil, &fsError{Code: "ERR", Message: "only volumes on LVM can be expanded"}
	}
	fstype := hostFSType(dev)
	mp := mountPointOf(hostProcMounts(), dev, lv.Path, lvDmPath(lv.VGName, lv.Name))
	mounted := mp != ""
	grow, fe := growFsSteps(fstype, lv.Path, mp, mounted)
	if fe != nil {
		return nil, fe
	}
	sys := hostSystemDevs()
	if sys[filepath.Base(dev)] {
		return nil, &fsError{Code: "ESYS", Message: "the system volume is not expanded here"}
	}

	var pvs, others []string
	for _, p := range hostPvs() {
		if p.VGName == lv.VGName {
			pvs = append(pvs, p.Name)
		}
	}
	for _, l := range hostLvs() {
		if l.VGName == lv.VGName {
			others = append(others, l.Name)
		}
	}
	sort.Strings(pvs)
	sort.Strings(others)
	obs := map[string]string{"device": dev, "fstype": fstype, "mounted": fmt.Sprint(mounted), "pvs": strings.Join(pvs, " "), "lvs": strings.Join(others, ",")}

	// The array under the VG, when its only PV is one.
	var array, arrayUUID string
	var members []string // active members only
	level, state := "", ""
	raidDevices := 0
	spares := 0
	if len(pvs) == 1 && reMdDev.MatchString(filepath.Base(hostRealPath(pvs[0]))) {
		array = filepath.Base(hostRealPath(pvs[0]))
		detail, _ := hostMdDetail("/dev/" + array)
		_, arrayUUID = parseMdDetail(detail)
		inTable := false
		for _, l := range strings.Split(detail, "\n") {
			t := strings.TrimSpace(l)
			if k, v, ok := strings.Cut(t, ":"); ok && !inTable {
				switch strings.TrimSpace(k) {
				case "Raid Level":
					level = strings.TrimSpace(v)
				case "State":
					state = strings.TrimSpace(v)
				case "Raid Devices":
					raidDevices, _ = strconv.Atoi(strings.TrimSpace(v))
				}
				continue
			}
			if strings.HasPrefix(t, "Number") && strings.Contains(t, "RaidDevice") {
				inTable = true
				continue
			}
			f := strings.Fields(t)
			if !inTable || len(f) == 0 || !strings.HasPrefix(f[len(f)-1], "/dev/") {
				continue
			}
			switch {
			case strings.Contains(t, "spare"):
				spares++
			case strings.Contains(t, "active sync"):
				members = append(members, f[len(f)-1])
			}
		}
		if raidDevices == 0 {
			raidDevices = len(members)
		}
		obs["members"] = strings.Join(members, " ")
		obs["sync"] = hostSyncAction(array)
		obs["state"] = state
		if strings.Contains(state, "degraded") {
			return nil, &fsError{Code: "EBUSY", Message: "/dev/" + array + " is degraded: replace its failed disk before expanding it"}
		}
		if s := obs["sync"]; s != "" && s != "idle" {
			return nil, &fsError{Code: "EBUSY", Message: "/dev/" + array + " is busy (" + s + "); expand it once that is over"}
		}
	}

	checkDisk := func() (string, *fsError) {
		if !reBlockDev.MatchString(req.Disk) || req.Disk == "" {
			return "", &fsError{Code: "ERR", Message: "choose a disk"}
		}
		if sys[req.Disk] {
			return "", &fsError{Code: "ESYS", Message: req.Disk + " belongs to the system disk"}
		}
		if !hostWholeDisk(req.Disk) {
			return "", &fsError{Code: "ERR", Message: req.Disk + " is not a whole disk"}
		}
		if fe := hostClaimable(req.Disk); fe != nil {
			return "", fe
		}
		d := "/dev/" + req.Disk
		observeDevice(obs, "disk", d)
		return d, nil
	}

	var steps []planStep
	pending := false
	switch req.Mode {
	case "vgFree":
		if hostVgFree(lv.VGName) <= 0 {
			return nil, &fsError{Code: "ERR", Message: "the volume group " + lv.VGName + " has no free space"}
		}
		steps = append(steps, cmdStep(lv.Path, "Give "+lv.Path+" the free space of "+lv.VGName, []string{"lvextend", "-l", "+100%FREE", lv.Path}))
		steps = append(steps, grow...)
	case "addDisk":
		if array != "" {
			return nil, &fsError{Code: "ERR", Message: "this volume is on a RAID array: add the disk to the array instead"}
		}
		d, fe := checkDisk()
		if fe != nil {
			return nil, fe
		}
		steps = append(steps,
			planStep{Kind: "info", Target: lv.VGName, Summary: "This volume will depend on one more disk: if any of its disks fails, the volume is lost"},
			destructive(cmdStep(d, "Prepare "+d+" for LVM, erasing its contents", []string{"pvcreate", "-f", d}), d),
			cmdStep(lv.VGName, "Add "+d+" to the volume group "+lv.VGName, []string{"vgextend", lv.VGName, d}),
			cmdStep(lv.Path, "Give "+lv.Path+" the new space", []string{"lvextend", "-l", "+100%FREE", lv.Path}))
		steps = append(steps, grow...)
	case "raidAddDisk":
		if level != "raid5" && level != "raid6" {
			return nil, &fsError{Code: "ERR", Message: "a disk adds capacity only to a RAID 5 or RAID 6 array"}
		}
		if spares > 0 {
			return nil, &fsError{Code: "ERR", Message: "/dev/" + array + " has a spare disk: the reshape would take it too. Remove the spare first"}
		}
		d, fe := checkDisk()
		if fe != nil {
			return nil, fe
		}
		size, _ := hostDeviceSize(d)
		smallest := int64(0)
		for _, m := range members {
			s, err := hostDeviceSize(m)
			if err != nil {
				return nil, &fsError{Code: "ERR", Message: "could not read the size of " + m}
			}
			if smallest == 0 || s < smallest {
				smallest = s
			}
		}
		if smallest == 0 || size < smallest {
			return nil, &fsError{Code: "ERR", Message: d + " is too small: the members of /dev/" + array + " are larger"}
		}
		raidDev := "/dev/" + array
		steps = append(steps,
			destructive(cmdStep(d, "Erase "+d+" to add it to "+raidDev, []string{"wipefs", "-a", d}), d),
			cmdStep(raidDev, "Add "+d+" to "+raidDev, []string{"mdadm", "--add", raidDev, d}),
			cmdStep(raidDev, fmt.Sprintf("Spread %s over %d disks (a reshape: hours, the volume stays usable)", raidDev, raidDevices+1),
				[]string{"mdadm", "--grow", raidDev, fmt.Sprintf("--raid-devices=%d", raidDevices+1)}))
		pending = true
	case "mirrorGrow":
		if level != "raid1" && level != "raid10" {
			return nil, &fsError{Code: "ERR", Message: "only a mirror grows to the size of its disks"}
		}
		component := hostComponentSize(array)
		grows := len(members) > 0
		for _, m := range members {
			// The superblock and data offset take a few MiB of each member.
			if s, err := hostDeviceSize(m); err != nil || s < component+(256<<20) {
				grows = false
			}
		}
		if !grows {
			return nil, &fsError{Code: "ERR", Message: "the disks of /dev/" + array + " are not larger than the space it uses"}
		}
		obs["component"] = fmt.Sprint(component)
		raidDev := "/dev/" + array
		steps = append(steps, cmdStep(raidDev, "Grow "+raidDev+" to the size of its disks (the new space is synchronised first)", []string{"mdadm", "--grow", raidDev, "--size=max"}))
		pending = true
	}

	if pending {
		oldSize := hostArraySize(array)
		obs["arraySize"] = fmt.Sprint(oldSize)
		entry := pendingExpansion{UUID: req.UUID, Array: array, ArrayUUID: arrayUUID, OldSize: oldSize, VG: lv.VGName, LV: lv.Path, FSType: fstype, MountPoint: mp, Phase: "reshape"}
		steps = append(steps, planStep{Kind: "later", Target: lv.Path, Deferred: true,
			Summary: "Grow LVM and the filesystem when the array is ready (HSI does it on its own)",
			run: func() (string, error) {
				entry.StartedAt = time.Now()
				return "", addPendingExpansion(entry)
			}})
	}
	p := &opPlan{Op: "volume.expand", Steps: steps, Observed: obs, Reply: map[string]any{"pending": pending}}
	// Described now with its new disk; the finisher describes it again once
	// the reshape grew it.
	if mounted {
		p.Redescribe = []string{mp}
	}
	return p, nil
}
