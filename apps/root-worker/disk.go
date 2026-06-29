package main

// disk.go — storage management: block device listing, format, mount/umount, RAID

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	nats "github.com/nats-io/nats.go"
)

// ── Validation patterns ───────────────────────────────────────────────────────

var (
	reBlockDev = regexp.MustCompile(`^[a-z][a-z0-9]+$`)    // sda, sda1, md0, nvme0n1p1
	reMdDev    = regexp.MustCompile(`^md[0-9]{1,3}$`)      // md0 … md999
)

// criticalMountPoints must never be unmounted or shadowed by a new mount.
var criticalMountPoints = map[string]bool{
	"/": true, "/boot": true, "/boot/efi": true, "/boot/grub": true,
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
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		dev, mnt := f[0], f[1]
		if criticalMountPoints[mnt] && strings.HasPrefix(dev, "/dev/") && !strings.HasPrefix(dev, "/dev/loop") {
			name := strings.TrimPrefix(dev, "/dev/")
			result[name] = true
			critDevs = append(critDevs, dev)
		}
	}

	// Walk up to the parent disk via lsblk.
	for _, dev := range critDevs {
		out, err := exec.Command("lsblk", "-no", "PKNAME", dev).Output()
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
	Children   []lsblkRaw  `json:"children"`
}

type lsblkOutput struct {
	BlockDevices []lsblkRaw `json:"blockdevices"`
}

// BlockDev is the enriched device info sent to the frontend.
type BlockDev struct {
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	Size        int64      `json:"size"`
	Type        string     `json:"type"`
	FsType      string     `json:"fstype"`
	MountPoint  string     `json:"mountpoint"`
	Model       string     `json:"model"`
	UUID        string     `json:"uuid"`
	IsSystem    bool       `json:"isSystem"`
	IsRemovable bool       `json:"isRemovable"`
	UsageTotal  int64      `json:"usageTotal"`
	UsageUsed   int64      `json:"usageUsed"`
	UsageFree   int64      `json:"usageFree"`
	Children    []BlockDev `json:"children,omitempty"`
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
		IsSystem:    isSys,
		IsRemovable: ifaceBool(r.RM),
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

	out, err := exec.Command("lsblk", "-J", "-b", "-o",
		"NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,UUID,RM").Output()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "lsblk failed: " + err.Error()})
		return
	}

	var raw lsblkOutput
	if err := json.Unmarshal(out, &raw); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "lsblk parse: " + err.Error()})
		return
	}

	devices := make([]BlockDev, 0, len(raw.BlockDevices))
	for _, r := range raw.BlockDevices {
		dev := convertDev(r, sysDevs, false)
		propagateSystem(&dev)
		devices = append(devices, dev)
	}

	mdData, _ := os.ReadFile("/proc/mdstat")
	raids := parseMdstat(string(mdData))

	replyOk(nc, msg.Reply, map[string]any{
		"devices": devices,
		"raids":   raids,
	})
}

// handleDiskFormat formats a block device with the requested filesystem.
// Safety: refuses to format system devices or mounted devices.
func handleDiskFormat(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Device string `json:"device"` // bare name: "sdb", "sdb1"
		FsType string `json:"fstype"` // ext4, xfs, btrfs, fat32
		Label  string `json:"label"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	if !reBlockDev.MatchString(req.Device) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid device name"})
		return
	}
	if systemDeviceNames()[req.Device] {
		replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: "cannot format system device — it is in use by the OS"})
		return
	}

	devPath := "/dev/" + req.Device

	// Refuse if mounted
	if mdata, _ := os.ReadFile("/proc/mounts"); mdata != nil {
		for _, line := range strings.Split(string(mdata), "\n") {
			if f := strings.Fields(line); len(f) > 0 && f[0] == devPath {
				replyErr(nc, msg.Reply, &fsError{Code: "EMNT", Message: "device is mounted — unmount it first"})
				return
			}
		}
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
		args = []string{"mkfs.vfat", "-F", "32"}
		if label != "" {
			l := label
			if len(l) > 11 {
				l = l[:11]
			}
			args = append(args, "-n", strings.ToUpper(l))
		}
	default:
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "unsupported filesystem: " + req.FsType})
		return
	}
	args = append(args, devPath)

	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
		return
	}

	// Notify kernel of new filesystem
	exec.Command("partprobe", devPath).Run()
	exec.Command("udevadm", "settle").Run()

	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

// handleDiskMount mounts a device at the given mount point, optionally
// persisting the entry in /etc/fstab via UUID.
func handleDiskMount(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Device     string `json:"device"`
		MountPoint string `json:"mountpoint"`
		Options    string `json:"options"`
		Persist    bool   `json:"persist"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	if !reBlockDev.MatchString(req.Device) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid device name"})
		return
	}

	mp := filepath.Clean(req.MountPoint)
	if !filepath.IsAbs(mp) || strings.Contains(mp, "..") {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid mount point path"})
		return
	}
	// Reject fstab structural characters: newline/CR/tab would inject extra
	// fstab lines; space and # break field parsing / start comments.
	if strings.ContainsAny(mp, "\n\r\t #") {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "mount point contains invalid characters"})
		return
	}
	if criticalMountPoints[mp] {
		replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: "cannot mount over system directory " + mp})
		return
	}

	devPath := "/dev/" + req.Device

	if err := os.MkdirAll(mp, 0755); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "create mountpoint: " + err.Error()})
		return
	}

	opts := req.Options
	if opts == "" {
		opts = "defaults"
	}
	// Options are a single fstab field; a newline or tab would break the line.
	if strings.ContainsAny(opts, "\n\r\t") {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "mount options contain invalid characters"})
		return
	}

	out, err := exec.Command("mount", "-o", opts, devPath, mp).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
		return
	}

	if req.Persist {
		uuidOut, _ := exec.Command("blkid", "-s", "UUID", "-o", "value", devPath).Output()
		uuid := strings.TrimSpace(string(uuidOut))
		fstypeOut, _ := exec.Command("blkid", "-s", "TYPE", "-o", "value", devPath).Output()
		fstype := strings.TrimSpace(string(fstypeOut))
		if fstype == "" {
			fstype = "auto"
		}
		var entry string
		if uuid != "" {
			entry = fmt.Sprintf("UUID=%s\t%s\t%s\t%s\t0\t2\n", uuid, mp, fstype, opts)
		} else {
			entry = fmt.Sprintf("%s\t%s\t%s\t%s\t0\t2\n", devPath, mp, fstype, opts)
		}
		f, ferr := os.OpenFile("/etc/fstab", os.O_APPEND|os.O_WRONLY, 0644)
		if ferr == nil {
			_, _ = f.WriteString(entry)
			f.Close()
		}
	}

	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

// handleDiskUmount unmounts a mount point, optionally removing its fstab entry.
func handleDiskUmount(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		MountPoint      string `json:"mountpoint"`
		RemoveFromFstab bool   `json:"removeFromFstab"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}

	mp := filepath.Clean(req.MountPoint)
	if !filepath.IsAbs(mp) || strings.Contains(mp, "..") {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid mount point"})
		return
	}
	if criticalMountPoints[mp] {
		replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: "cannot unmount system directory"})
		return
	}

	out, err := exec.Command("umount", mp).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
		return
	}

	if req.RemoveFromFstab {
		removeFstabEntry(mp)
	}

	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func removeFstabEntry(mountPoint string) {
	data, err := os.ReadFile("/etc/fstab")
	if err != nil {
		return
	}
	var keep []string
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		line := sc.Text()
		if f := strings.Fields(line); len(f) >= 2 && f[1] == mountPoint {
			continue
		}
		keep = append(keep, line)
	}
	_ = os.WriteFile("/etc/fstab", []byte(strings.Join(keep, "\n")+"\n"), 0644)
}

// handleRaidCreate creates a Linux software RAID array using mdadm.
func handleRaidCreate(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Name    string   `json:"name"`    // "md0"
		Level   int      `json:"level"`   // 0, 1, 5, 10
		Devices []string `json:"devices"` // ["sdb", "sdc", ...]
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	if !reMdDev.MatchString(req.Name) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid RAID name — must be md0, md1, … md999"})
		return
	}

	minDev := map[int]int{0: 2, 1: 2, 5: 3, 10: 4}
	required, ok := minDev[req.Level]
	if !ok {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: fmt.Sprintf("unsupported RAID level %d", req.Level)})
		return
	}
	if len(req.Devices) < required {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: fmt.Sprintf("RAID %d needs at least %d devices (got %d)", req.Level, required, len(req.Devices))})
		return
	}

	sysDevs := systemDeviceNames()
	devPaths := make([]string, 0, len(req.Devices))
	for _, d := range req.Devices {
		if !reBlockDev.MatchString(d) {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid device name: " + d})
			return
		}
		if sysDevs[d] {
			replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: "device " + d + " belongs to the system disk"})
			return
		}
		devPaths = append(devPaths, "/dev/"+d)
	}

	raidDev := "/dev/" + req.Name
	args := append([]string{
		"mdadm", "--create", raidDev,
		"--level", fmt.Sprintf("%d", req.Level),
		"--raid-devices", fmt.Sprintf("%d", len(devPaths)),
		"--run",
	}, devPaths...)

	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
		return
	}

	// Persist mdadm config so the array auto-assembles on reboot.
	if confOut, cerr := exec.Command("mdadm", "--detail", "--scan").Output(); cerr == nil && len(confOut) > 0 {
		os.MkdirAll("/etc/mdadm", 0755)
		os.WriteFile("/etc/mdadm/mdadm.conf", confOut, 0644)
	}

	replyOk(nc, msg.Reply, map[string]any{"ok": true, "device": raidDev})
}

// handleRaidStop stops a RAID array and zeroes the superblocks on its members
// so the disks can be reused individually.
func handleRaidStop(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Name string `json:"name"` // "md0"
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	if !reMdDev.MatchString(req.Name) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid RAID name"})
		return
	}
	if systemDeviceNames()[req.Name] {
		replyErr(nc, msg.Reply, &fsError{Code: "ESYS", Message: "cannot destroy system RAID array"})
		return
	}

	raidDev := "/dev/" + req.Name

	// Refuse if mounted
	if mdata, _ := os.ReadFile("/proc/mounts"); mdata != nil {
		for _, line := range strings.Split(string(mdata), "\n") {
			if f := strings.Fields(line); len(f) > 0 && f[0] == raidDev {
				replyErr(nc, msg.Reply, &fsError{Code: "EMNT", Message: "RAID array is mounted — unmount it first"})
				return
			}
		}
	}

	// Capture member list before stopping
	detailOut, _ := exec.Command("mdadm", "--detail", raidDev).Output()

	out, err := exec.Command("mdadm", "--stop", raidDev).CombinedOutput()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
		return
	}

	// Zero superblocks on member devices so they show as clean disks.
	memberRe := regexp.MustCompile(`(?m)^\s+\d+\s+\d+\s+\d+\s+\w+\s+(/dev/\S+)\s*$`)
	for _, m := range memberRe.FindAllSubmatch(detailOut, -1) {
		if len(m) > 1 {
			exec.Command("mdadm", "--zero-superblock", string(m[1])).Run()
		}
	}

	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}
