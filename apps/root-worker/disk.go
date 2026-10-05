package main

// disk.go: storage management: block devices, format, mount/umount, RAID, LVM, partitions

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	nats "github.com/nats-io/nats.go"
)

// ── Validation patterns ───────────────────────────────────────────────────────

var (
	// Bare name (sda1, md0) or relative LVM path (ubuntu-vg/ubuntu-lv).
	// Hyphens and one forward slash are allowed; ".." and leading "/" are rejected.
	reBlockDev = regexp.MustCompile(`^[a-z][a-z0-9_-]*(?:/[a-z][a-z0-9_-]*)?$`)
	reMdDev    = regexp.MustCompile(`^md[0-9]{1,3}$`) // md0 … md999
)

// criticalMountPoints must never be unmounted or shadowed by a new mount.
var criticalMountPoints = map[string]bool{
	"/": true, "/boot": true, "/boot/efi": true, "/boot/grub": true, "/boot/firmware": true, "/efi": true,
	"/usr": true, "/var": true, "/home": true, "/tmp": true,
	"/etc": true, "/proc": true, "/sys": true, "/dev": true,
}

// ── System disk detection ─────────────────────────────────────────────────────

// systemDeviceNames returns all device short-names (e.g. "sda", "sda1", "md0")
// that belong to the OS disk.  These must never be formatted, used in RAID, or
// unmounted.
func systemDeviceNames() map[string]bool {
	result := map[string]bool{}

	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return result
	}

	// Collect devices mounted at critical paths.
	critDevs := []string{}
	for _, name := range systemMountDevices(string(data), rootDeviceName) {
		result[name] = true
		critDevs = append(critDevs, "/dev/"+name)
	}

	// Walk up to the parent disk via lsblk.
	for _, dev := range critDevs {
		out, err := command("lsblk", "-no", "PKNAME", dev).Output()
		if err != nil {
			continue
		}
		for _, parent := range strings.Fields(string(out)) {
			if parent != "" {
				result[parent] = true
			}
		}
	}

	return result
}

// systemMountDevices returns the lsblk names of the devices mounted at a
// critical path. /dev/mapper/X is X in lsblk; /dev/root (Raspberry Pi and
// some initramfs setups) is resolved through rootDevice.
func systemMountDevices(procMounts string, rootDevice func() string) []string {
	var out []string
	for _, line := range strings.Split(procMounts, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || !criticalMountPoints[f[1]] || !strings.HasPrefix(f[0], "/dev/") || strings.HasPrefix(f[0], "/dev/loop") {
			continue
		}
		name := strings.TrimPrefix(f[0], "/dev/")
		name = strings.TrimPrefix(name, "mapper/")
		if name == "root" {
			if name = rootDevice(); name == "" {
				continue
			}
		}
		out = append(out, name)
	}
	return out
}

// rootDeviceName finds the block device of / from its device number
// (/sys/dev/block/<major>:<minor>), for a root mounted as /dev/root.
func rootDeviceName() string {
	var st syscall.Stat_t
	if err := syscall.Stat("/", &st); err != nil {
		return ""
	}
	major, minor := (st.Dev>>8)&0xfff|(st.Dev>>32)&^0xfff, st.Dev&0xff|(st.Dev>>12)&^0xff
	b, err := os.ReadFile(fmt.Sprintf("/sys/dev/block/%d:%d/uevent", major, minor))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "DEVNAME="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ── lsblk types ───────────────────────────────────────────────────────────────

// lsblkRaw mirrors lsblk JSON output.  All fields are interface{} because
// different util-linux versions encode nulls and booleans inconsistently.
type lsblkRaw struct {
	Name       string      `json:"name"`
	Size       interface{} `json:"size"`
	Type       string      `json:"type"`
	FsType     interface{} `json:"fstype"`
	MountPoint interface{} `json:"mountpoint"`
	Model      interface{} `json:"model"`
	UUID       interface{} `json:"uuid"`
	RM         interface{} `json:"rm"`
	Serial     interface{} `json:"serial"`
	WWN        interface{} `json:"wwn"`
	Label      interface{} `json:"label"`
	Children   []lsblkRaw  `json:"children"`
}

type lsblkOutput struct {
	BlockDevices []lsblkRaw `json:"blockdevices"`
}

// BlockDev is the enriched device info sent to the frontend.
type BlockDev struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	Type        string `json:"type"`
	FsType      string `json:"fstype"`
	MountPoint  string `json:"mountpoint"`
	Model       string `json:"model"`
	UUID        string `json:"uuid"`
	Label       string `json:"label,omitempty"` // filesystem label
	Serial      string `json:"serial,omitempty"`
	WWN         string `json:"wwn,omitempty"`
	ByID        string `json:"byId,omitempty"` // preferred /dev/disk/by-id name
	IsSystem    bool   `json:"isSystem"`
	IsRemovable bool   `json:"isRemovable"`
	UsageTotal  int64  `json:"usageTotal"`
	UsageUsed   int64  `json:"usageUsed"`
	UsageFree   int64  `json:"usageFree"`
	// Usage is what the device is used for; see assignUsage. Owner names the
	// array (md0) or volume group that uses a member, when it is known.
	Usage    string     `json:"usage"`
	Owner    string     `json:"owner,omitempty"`
	Children []BlockDev `json:"children"`
}

// Helpers for lsblkRaw fields that can be null/bool/string/number.
func ifaceStr(v interface{}) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func ifaceInt64(v interface{}) int64 {
	if v == nil {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return int64(n)
	case string:
		var i int64
		fmt.Sscanf(n, "%d", &i)
		return i
	}
	return 0
}

func ifaceBool(v interface{}) bool {
	if v == nil {
		return false
	}
	switch b := v.(type) {
	case bool:
		return b
	case string:
		return b == "1" || strings.EqualFold(b, "true")
	case float64:
		return b != 0
	}
	return false
}

func convertDev(r lsblkRaw, sysDevs map[string]bool, parentSys bool) BlockDev {
	name := r.Name
	mp := ifaceStr(r.MountPoint)
	isSys := sysDevs[name] || parentSys

	dev := BlockDev{
		Name:        name,
		Path:        "/dev/" + name,
		Size:        ifaceInt64(r.Size),
		Type:        r.Type,
		FsType:      ifaceStr(r.FsType),
		MountPoint:  mp,
		Model:       strings.TrimSpace(ifaceStr(r.Model)),
		UUID:        ifaceStr(r.UUID),
		Serial:      ifaceStr(r.Serial),
		WWN:         ifaceStr(r.WWN),
		Label:       ifaceStr(r.Label),
		IsSystem:    isSys,
		IsRemovable: ifaceBool(r.RM),
		Children:    []BlockDev{},
	}

	if mp != "" {
		var st syscall.Statfs_t
		if err := syscall.Statfs(mp, &st); err == nil {
			bs := int64(st.Bsize)
			dev.UsageTotal = int64(st.Blocks) * bs
			dev.UsageFree = int64(st.Bavail) * bs
			dev.UsageUsed = dev.UsageTotal - int64(st.Bfree)*bs
		}
	}

	for _, child := range r.Children {
		dev.Children = append(dev.Children, convertDev(child, sysDevs, isSys))
	}
	return dev
}

// propagateSystem ensures that if a disk is system, all its children are too.
func propagateSystem(dev *BlockDev) {
	if dev.IsSystem {
		for i := range dev.Children {
			dev.Children[i].IsSystem = true
			propagateSystem(&dev.Children[i])
		}
	} else {
		for i := range dev.Children {
			propagateSystem(&dev.Children[i])
		}
	}
}

// ── Handlers ──────────────────────────────────────────────────────────────────

func handleBlockDevices(nc *nats.Conn, msg *nats.Msg) {
	sysDevs := systemDeviceNames()

	out, err := command("lsblk", "-J", "-b", "-o",
		"NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,UUID,RM,SERIAL,WWN,LABEL").Output()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "lsblk failed: " + err.Error()})
		return
	}

	var raw lsblkOutput
	if err := json.Unmarshal(out, &raw); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "lsblk parse: " + err.Error()})
		return
	}

	pvVG := map[string]string{}
	if pvsOut, err := command("pvs", "--noheadings", "--separator", ":", "-o", "pv_name,vg_name").Output(); err == nil {
		pvVG = parsePvs(string(pvsOut))
	}

	devices := make([]BlockDev, 0, len(raw.BlockDevices))
	for _, r := range raw.BlockDevices {
		dev := convertDev(r, sysDevs, false)
		propagateSystem(&dev)
		assignUsage(&dev, pvVG)
		devices = append(devices, dev)
	}
	assignByID(devices, preferredByID(hostByIDLinks()))

	mdData, _ := os.ReadFile("/proc/mdstat")
	raids := parseMdstat(string(mdData))
	markRebuilding(raids)
	addCheckResults(raids)

	replyOk(nc, msg.Reply, map[string]any{
		"devices": devices,
		"raids":   raids,
	})
}

// handleDiskFormat formats a block device with the requested filesystem.
// Safety: refuses to format system devices or mounted devices.
func handleDiskFormat(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planFormat) }

// handleDiskMount mounts a device at the given mount point, optionally
// persisting the entry in /etc/fstab via UUID.
func handleDiskMount(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planMount) }

// handleDiskUmount unmounts a mount point, optionally removing its fstab entry.
func handleDiskUmount(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planUmount) }

// mountSources returns the fstab source forms of the device mounted on
// mountPoint: its /dev path and UUID=… when it has one.
func mountSources(mountPoint string) []string {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[1] != mountPoint {
			continue
		}
		sources := []string{f[0]}
		if out, err := command("blkid", "-s", "UUID", "-o", "value", f[0]).Output(); err == nil {
			if uuid := strings.TrimSpace(string(out)); uuid != "" {
				sources = append(sources, "UUID="+uuid)
			}
		}
		return sources
	}
	return nil
}

// handleRaidCreate creates a Linux software RAID array using mdadm.
func handleRaidCreate(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planRaidCreate) }

// handleRaidStop stops a RAID array and zeroes the superblocks on its members
// so the disks can be reused individually.
func handleRaidStop(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planRaidStop) }

// ── LVM ───────────────────────────────────────────────────────────────────────

type lvmPV struct {
	Name   string `json:"name"`
	VGName string `json:"vgName"`
	Size   int64  `json:"size"`
	Free   int64  `json:"free"`
}

type lvmVG struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Free    int64  `json:"free"`
	PVCount int    `json:"pvCount"`
	LVCount int    `json:"lvCount"`
}

type lvmLV struct {
	Name   string `json:"name"`
	VGName string `json:"vgName"`
	Size   int64  `json:"size"`
	Path   string `json:"path"`
}

func lvmParseInt(s string) int64 {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "B"))
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func lvmParseCount(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

type lvmReportRaw struct {
	Report []map[string][]map[string]string `json:"report"`
}

func parseLvmReport(data []byte, key string) []map[string]string {
	var r lvmReportRaw
	if err := json.Unmarshal(data, &r); err != nil || len(r.Report) == 0 {
		return nil
	}
	return r.Report[0][key]
}

func lvmCmd(args ...string) []byte {
	out, err := command(args[0], args[1:]...).Output()
	if err != nil {
		return []byte(`{"report":[]}`)
	}
	return out
}

func getLvmInfo() (pvs []lvmPV, vgs []lvmVG, lvs []lvmLV) {
	pvOut := lvmCmd("pvs", "--reportformat", "json", "--units", "b", "--nosuffix",
		"-o", "pv_name,vg_name,pv_size,pv_free")
	for _, row := range parseLvmReport(pvOut, "pv") {
		pvs = append(pvs, lvmPV{
			Name:   row["pv_name"],
			VGName: row["vg_name"],
			Size:   lvmParseInt(row["pv_size"]),
			Free:   lvmParseInt(row["pv_free"]),
		})
	}

	vgOut := lvmCmd("vgs", "--reportformat", "json", "--units", "b", "--nosuffix",
		"-o", "vg_name,vg_size,vg_free,pv_count,lv_count")
	for _, row := range parseLvmReport(vgOut, "vg") {
		vgs = append(vgs, lvmVG{
			Name:    row["vg_name"],
			Size:    lvmParseInt(row["vg_size"]),
			Free:    lvmParseInt(row["vg_free"]),
			PVCount: lvmParseCount(row["pv_count"]),
			LVCount: lvmParseCount(row["lv_count"]),
		})
	}

	lvOut := lvmCmd("lvs", "--reportformat", "json", "--units", "b", "--nosuffix",
		"-o", "lv_name,vg_name,lv_size,lv_path")
	for _, row := range parseLvmReport(lvOut, "lv") {
		path := row["lv_path"]
		if path == "" {
			path = "/dev/" + row["vg_name"] + "/" + row["lv_name"]
		}
		lvs = append(lvs, lvmLV{
			Name:   row["lv_name"],
			VGName: row["vg_name"],
			Size:   lvmParseInt(row["lv_size"]),
			Path:   path,
		})
	}
	return
}

// blkNode is one row of `lsblk -P -o NAME,FSTYPE,MOUNTPOINT <dev>`: the device
// itself first, then everything stacked on it (partitions, arrays, LVs).
type blkNode struct {
	Name       string
	FsType     string
	MountPoint string
}

var reLsblkPair = regexp.MustCompile(`([A-Z]+)="([^"]*)"`)

// parseLsblkPairs parses lsblk's key="value" output (-P). Unlike the raw
// format, empty columns keep their position, so an empty FSTYPE cannot shift
// MOUNTPOINT into its place.
func parseLsblkPairs(out string) []blkNode {
	var nodes []blkNode
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var n blkNode
		for _, m := range reLsblkPair.FindAllStringSubmatch(line, -1) {
			switch m[1] {
			case "NAME":
				n.Name = m[2]
			case "FSTYPE":
				n.FsType = m[2]
			case "MOUNTPOINT":
				n.MountPoint = m[2]
			}
		}
		if n.Name != "" {
			nodes = append(nodes, n)
		}
	}
	return nodes
}

// memberReason explains why a device tree belongs to a RAID array or an LVM
// volume group (the device itself or one of its partitions), or returns "".
func memberReason(nodes []blkNode) string {
	for _, n := range nodes {
		switch n.FsType {
		case "linux_raid_member":
			return "device " + n.Name + " is a member of a RAID array"
		case "LVM2_member":
			return "device " + n.Name + " is an LVM physical volume"
		}
	}
	return ""
}

// claimBlockReason explains why a device cannot be claimed by a new RAID array
// or LVM physical volume, or returns "" when it is free: not a member, not
// mounted, no filesystem, and (for a disk) no partitions that would be lost.
func claimBlockReason(nodes []blkNode) string {
	if len(nodes) == 0 {
		return "could not inspect the device, refusing to proceed"
	}
	if r := memberReason(nodes); r != "" {
		return r
	}
	for _, n := range nodes {
		if n.MountPoint != "" {
			return "device " + n.Name + " is mounted on " + n.MountPoint + "; unmount it first"
		}
		if n.FsType != "" {
			return "device " + n.Name + " contains a " + n.FsType + " filesystem; format or wipe it first"
		}
	}
	if len(nodes) > 1 {
		return "device " + nodes[0].Name + " has partitions; use a partition, or wipe the partition table first"
	}
	return ""
}

func lsblkTree(device string) ([]blkNode, error) {
	out, err := command("lsblk", "-P", "-o", "NAME,FSTYPE,MOUNTPOINT", devPathFor(device)).Output()
	if err != nil {
		return nil, err
	}
	return parseLsblkPairs(string(out)), nil
}

// isRaidOrLvmMember reports whether device (bare name, e.g. "sdb1") or any of
// its child partitions is currently a RAID member or LVM physical volume:
// even if the array isn't assembled, the VG isn't visible to `pvs` (e.g. an
// LVM devices-file exclusion), or the member is a partition of the disk
// being checked rather than the disk itself. Used to block destructive
// operations (format, partition create/delete/init, mount) that would silently
// corrupt the array/VG. Fails closed: if lsblk itself can't be queried, the
// device is treated as a member (block, don't guess): an unverifiable claim on
// a path this destructive is treated as "assume dangerous".
func isRaidOrLvmMember(device string) (bool, string) {
	nodes, err := lsblkTree(device)
	if err != nil || len(nodes) == 0 {
		return true, "could not verify device usage, refusing to proceed"
	}
	if r := memberReason(nodes); r != "" {
		return true, r
	}
	return false, ""
}

// checkDeviceClaimable refuses devices that a new RAID array or PV would
// silently destroy. mdadm --run and pvcreate -f skip their own confirmation
// prompts, so this check is the only safeguard before they overwrite data.
func checkDeviceClaimable(device string) *fsError {
	nodes, err := lsblkTree(device)
	if err != nil {
		return &fsError{Code: "EBUSY", Message: "could not inspect device " + device + ": " + err.Error()}
	}
	if r := claimBlockReason(nodes); r != "" {
		return &fsError{Code: "EBUSY", Message: r}
	}
	return nil
}

func handleLvmInfo(nc *nats.Conn, msg *nats.Msg) {
	pvs, vgs, lvs := getLvmInfo()
	replyOk(nc, msg.Reply, map[string]any{"pvs": pvs, "vgs": vgs, "lvs": lvs})
}

var reVGName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,30}$`)

func handlePvCreate(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planPvCreate) }

func handleVgCreate(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planVgCreate) }

func handleLvCreate(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planLvCreate) }

// lvDmPath returns the /dev/mapper path the kernel actually reports in
// /proc/mounts for an LV: mount(2) canonicalizes through devicemapper, so
// /dev/<vg>/<lv> (what lvcreate/lvs report) never appears there; only
// /dev/mapper/<vg>-<lv> does, with any literal "-" in the vg/lv name doubled.
// Mirrors the frontend's lvToDmName (useStorageData.ts).
func lvDmPath(vgName, lvName string) string {
	esc := func(s string) string { return strings.ReplaceAll(s, "-", "--") }
	return "/dev/mapper/" + esc(vgName) + "-" + esc(lvName)
}

func handleLvRemove(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planLvRemove) }

func handleVgRemove(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planVgRemove) }

// ── Partition management ──────────────────────────────────────────────────────

var rePartNum = regexp.MustCompile(`^[1-9][0-9]?$`) // 1–99

// handlePartitionInit creates a fresh GPT partition table; destroys all data.
func handlePartitionInit(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planPartInit) }

// handlePartitionCreate adds a new partition using percentage-based placement.
// startPct and endPct define the position within the disk (0–100).
// endPct=0 means "extend to end of disk".
func handlePartitionCreate(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planPartCreate) }

// ── S.M.A.R.T. ───────────────────────────────────────────────────────────────

// criticalAttrIDs are ATA SMART attribute IDs where a non-zero raw value
// indicates a problem (reallocated sectors, pending sectors, uncorrectables…).
var criticalAttrIDs = map[int]bool{
	5: true, 10: true, 187: true, 188: true, 197: true, 198: true, 199: true,
}

// smartctlJSON is a partial mapping of `smartctl -j -a` output.
type smartctlJSON struct {
	Smartctl struct {
		ExitStatus int `json:"exit_status"`
	} `json:"smartctl"`
	ModelFamily     string `json:"model_family"`
	ModelName       string `json:"model_name"`
	SerialNumber    string `json:"serial_number"`
	FirmwareVersion string `json:"firmware_version"`
	RotationRate    int    `json:"rotation_rate"`
	// Absent when the device does not report an overall health status
	// (virtio disks, many USB bridges): a pointer keeps "unknown" distinct
	// from "failed".
	SmartStatus *struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	Temperature struct {
		Current int `json:"current"`
	} `json:"temperature"`
	PowerOnTime struct {
		Hours int64 `json:"hours"`
	} `json:"power_on_time"`
	PowerCycleCount    int64 `json:"power_cycle_count"`
	AtaSmartAttributes struct {
		Table []struct {
			ID         int    `json:"id"`
			Name       string `json:"name"`
			Value      int    `json:"value"`
			Worst      int    `json:"worst"`
			Thresh     int    `json:"thresh"`
			WhenFailed string `json:"when_failed"`
			Raw        struct {
				Value int64 `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	NvmeLog struct {
		CriticalWarning      int   `json:"critical_warning"`
		Temperature          int   `json:"temperature"`
		AvailableSpare       int   `json:"available_spare"`
		AvailableSpareThresh int   `json:"available_spare_threshold"`
		PercentageUsed       int   `json:"percentage_used"`
		DataUnitsRead        int64 `json:"data_units_read"`
		DataUnitsWritten     int64 `json:"data_units_written"`
		MediaErrors          int64 `json:"media_errors"`
		NumErrLogEntries     int64 `json:"num_err_log_entries"`
	} `json:"nvme_smart_health_information_log"`
}

// smartctl(8) exit status bits.
const (
	smartExitCmdLine      = 1 << 0 // command line or device type not recognised
	smartExitOpenFailed   = 1 << 1 // device open failed, or in low-power mode (-n)
	smartExitCmdFailed    = 1 << 2 // a SMART command failed or returned a checksum error
	smartExitDiskFailing  = 1 << 3 // SMART status: DISK FAILING
	smartExitPrefail      = 1 << 4 // prefail attributes at or below threshold
	smartExitUsage        = 1 << 5 // usage attributes were past threshold
	smartExitErrorLog     = 1 << 6 // device error log contains errors
	smartExitSelfTestFail = 1 << 7 // self-test log contains errors
)

// evalSmart classifies smartctl -j output. A device is available when smartctl
// could read SMART data from it; health is "failed" only on an explicit failed
// status, "passed" on an explicit passed status, and "unknown" otherwise, so
// devices without SMART support are never reported as failing.
// smartUnsupported reports whether a device without SMART data was opened
// fine (so it does not support SMART), as opposed to being in standby or
// failing to open (bit 1), where the answer may change on the next check.
func smartUnsupported(sc smartctlJSON) bool {
	return sc.Smartctl.ExitStatus&smartExitOpenFailed == 0
}

func evalSmart(sc smartctlJSON) (available bool, health string, warnings []string) {
	st := sc.Smartctl.ExitStatus
	nvmePresent := sc.NvmeLog.Temperature > 0 || sc.NvmeLog.AvailableSpare > 0 ||
		sc.NvmeLog.PercentageUsed > 0 || sc.NvmeLog.DataUnitsRead > 0
	hasData := sc.SmartStatus != nil || len(sc.AtaSmartAttributes.Table) > 0 || nvmePresent
	if !hasData || st&(smartExitCmdLine|smartExitOpenFailed) != 0 && sc.SmartStatus == nil {
		return false, "unknown", nil
	}

	switch {
	case st&smartExitDiskFailing != 0 || (sc.SmartStatus != nil && !sc.SmartStatus.Passed):
		health = "failed"
	case sc.SmartStatus != nil && sc.SmartStatus.Passed:
		health = "passed"
	default:
		health = "unknown"
	}

	for _, w := range []struct {
		bit int
		msg string
	}{
		{smartExitCmdFailed, "some SMART commands failed or returned a checksum error"},
		{smartExitPrefail, "prefail attributes are at or below their threshold"},
		{smartExitUsage, "usage attributes were past their threshold"},
		{smartExitErrorLog, "the device error log contains errors"},
		{smartExitSelfTestFail, "the self-test log contains errors"},
	} {
		if st&w.bit != 0 {
			warnings = append(warnings, w.msg)
		}
	}
	return true, health, warnings
}

type SmartAttr struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Value      int    `json:"value"`
	Worst      int    `json:"worst"`
	Thresh     int    `json:"thresh"`
	Raw        int64  `json:"raw"`
	Failed     bool   `json:"failed"`
	IsCritical bool   `json:"isCritical"`
}

type NvmeInfo struct {
	CriticalWarning      int     `json:"criticalWarning"`
	Temperature          int     `json:"temperature"`
	AvailableSpare       int     `json:"availableSpare"`
	AvailableSpareThresh int     `json:"availableSpareThresh"`
	PercentageUsed       int     `json:"percentageUsed"`
	DataReadTiB          float64 `json:"dataReadTiB"`
	DataWrittenTiB       float64 `json:"dataWrittenTiB"`
	MediaErrors          int64   `json:"mediaErrors"`
	ErrorLogEntries      int64   `json:"errorLogEntries"`
}

type SmartResult struct {
	Device       string   `json:"device"`
	Available    bool     `json:"available"`
	ModelFamily  string   `json:"modelFamily,omitempty"`
	ModelName    string   `json:"modelName,omitempty"`
	SerialNumber string   `json:"serialNumber,omitempty"`
	Firmware     string   `json:"firmware,omitempty"`
	RotationRate int      `json:"rotationRate"` // 0 = SSD/NVMe
	HealthPassed bool     `json:"healthPassed"` // Health == "passed"; kept for older clients
	Health       string   `json:"health"`       // passed | failed | unknown
	Warnings     []string `json:"warnings"`     // smartctl exit status bits 2, 4-7
	// Unsupported: smartctl opened the device but it exposes no SMART data
	// (virtio, many USB bridges). Unlike a disk in standby, this is a final
	// answer, so stale health alerts for the device can be cleared.
	Unsupported  bool        `json:"unsupported,omitempty"`
	Temperature  int         `json:"temperature"`
	PowerOnHours int64       `json:"powerOnHours"`
	PowerCycles  int64       `json:"powerCycles"`
	Attributes   []SmartAttr `json:"attributes"`
	Nvme         *NvmeInfo   `json:"nvme,omitempty"`
}

// handleSmartInfo queries S.M.A.R.T. data for a single block device.
func handleSmartInfo(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Device string `json:"device"`           // bare name: sda, sdb, nvme0n1
		NoWake bool   `json:"noWake,omitempty"` // skip (don't spin up) a disk currently in standby
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || !reBlockDev.MatchString(req.Device) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid device"})
		return
	}

	result := SmartResult{
		Device:     req.Device,
		Attributes: []SmartAttr{},
	}

	// Check smartctl is available
	smartctlPath, err := exec.LookPath("smartctl")
	if err != nil {
		replyOk(nc, msg.Reply, result) // available=false, no error
		return
	}

	args := []string{"-j", "-a"}
	if req.NoWake {
		args = append(args, "-n", "standby")
	}
	args = append(args, "/dev/"+req.Device)
	raw, err := command(smartctlPath, args...).Output()
	if err != nil && len(raw) == 0 {
		replyOk(nc, msg.Reply, result)
		return
	}

	var sc smartctlJSON
	if err := json.Unmarshal(raw, &sc); err != nil {
		replyOk(nc, msg.Reply, result)
		return
	}

	available, health, warnings := evalSmart(sc)
	if !available {
		result.Unsupported = smartUnsupported(sc)
		replyOk(nc, msg.Reply, result)
		return
	}

	result.Available = true
	result.Health = health
	result.Warnings = warnings
	result.ModelFamily = strings.TrimSpace(sc.ModelFamily)
	result.ModelName = strings.TrimSpace(sc.ModelName)
	result.SerialNumber = strings.TrimSpace(sc.SerialNumber)
	result.Firmware = strings.TrimSpace(sc.FirmwareVersion)
	result.RotationRate = sc.RotationRate
	result.HealthPassed = health == "passed"
	result.Temperature = sc.Temperature.Current
	result.PowerOnHours = sc.PowerOnTime.Hours
	result.PowerCycles = sc.PowerCycleCount

	// ATA attributes
	for _, a := range sc.AtaSmartAttributes.Table {
		result.Attributes = append(result.Attributes, SmartAttr{
			ID:         a.ID,
			Name:       a.Name,
			Value:      a.Value,
			Worst:      a.Worst,
			Thresh:     a.Thresh,
			Raw:        a.Raw.Value,
			Failed:     a.WhenFailed != "" && a.WhenFailed != "-",
			IsCritical: criticalAttrIDs[a.ID],
		})
	}

	// NVMe health log
	if sc.NvmeLog.Temperature > 0 || sc.NvmeLog.PercentageUsed > 0 || sc.NvmeLog.MediaErrors > 0 {
		// NVMe data units are in 512,000-byte blocks; convert to TiB
		const blockBytes = 512_000.0
		const tiB = 1024.0 * 1024.0 * 1024.0 * 1024.0
		result.Nvme = &NvmeInfo{
			CriticalWarning:      sc.NvmeLog.CriticalWarning,
			Temperature:          sc.NvmeLog.Temperature,
			AvailableSpare:       sc.NvmeLog.AvailableSpare,
			AvailableSpareThresh: sc.NvmeLog.AvailableSpareThresh,
			PercentageUsed:       sc.NvmeLog.PercentageUsed,
			DataReadTiB:          float64(sc.NvmeLog.DataUnitsRead) * blockBytes / tiB,
			DataWrittenTiB:       float64(sc.NvmeLog.DataUnitsWritten) * blockBytes / tiB,
			MediaErrors:          sc.NvmeLog.MediaErrors,
			ErrorLogEntries:      sc.NvmeLog.NumErrLogEntries,
		}
		// NVMe temperature overrides (ATA Temperature attr is absent for NVMe)
		if result.Temperature == 0 && sc.NvmeLog.Temperature > 0 {
			result.Temperature = sc.NvmeLog.Temperature
		}
	}

	replyOk(nc, msg.Reply, result)
}

// handlePartitionDelete removes a partition by its number.
func handlePartitionDelete(nc *nats.Conn, msg *nats.Msg) { servePlanOp(nc, msg, planPartDelete) }
