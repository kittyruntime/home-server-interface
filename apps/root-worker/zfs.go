package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	nats "github.com/nats-io/nats.go"
)

// ── ZFS (lot 1) ──────────────────────────────────────────────────────────────
// HSI never installs ZFS: when the host has it, the worker reads its pools and
// datasets from the zpool and zfs commands. The parsers below are pure and
// tested on captured outputs (OpenZFS 2.1 to 2.3 print the same text).

// zfsVdev is a node of a pool's configuration: a group (mirror, raidzN, a
// replacing or spare pair, or a log/cache/special class) or a leaf disk.
type zfsVdev struct {
	Name     string    `json:"name"`
	Type     string    `json:"type"` // mirror, raidz1-3, draid, disk, replacing, spare, log, cache, special
	State    string    `json:"state"`
	Path     string    `json:"path,omitempty"` // a leaf's device path, as zpool status -P prints it
	Disk     string    `json:"disk,omitempty"` // a leaf's whole disk (sdb), filled by the handler
	Read     int64     `json:"read"`
	Write    int64     `json:"write"`
	Checksum int64     `json:"checksum"`
	Children []zfsVdev `json:"children"`
}

// zfsScan is the last or running scrub or resilver of a pool.
type zfsScan struct {
	Kind     string   `json:"kind"`  // scrub, resilver, none
	State    string   `json:"state"` // finished, running, canceled, none
	End      string   `json:"end,omitempty"`
	Start    string   `json:"start,omitempty"` // a running scan: since when
	Repaired int64    `json:"repaired"`
	Errors   int64    `json:"errors"`
	Percent  *float64 `json:"percent,omitempty"`
}

type zfsPool struct {
	Name  string    `json:"name"`
	GUID  string    `json:"guid"`
	State string    `json:"state"`
	Size  int64     `json:"size"`
	Alloc int64     `json:"alloc"`
	Free  int64     `json:"free"`
	Frag  int       `json:"frag"`
	Vdevs []zfsVdev `json:"vdevs"`
	Scan  zfsScan   `json:"scan"`
	// Expand: a raidz expansion; ExpandSize: bytes the disks have beyond
	// what the pool uses (bigger disks put in).
	Expand     zfsExpand `json:"expand"`
	ExpandSize int64     `json:"expandSize"`
}

type zfsDataset struct {
	Name        string  `json:"name"`
	Pool        string  `json:"pool"`
	MountPoint  string  `json:"mountPoint"`
	Compression string  `json:"compression"`
	CanMount    string  `json:"canMount"` // on, off, noauto
	Used        int64   `json:"used"`
	Avail       int64   `json:"avail"`
	Quota       int64   `json:"quota"`
	Mounted     bool    `json:"mounted"`
	Ratio       float64 `json:"ratio"`
}

// zfsImportable is a pool found on the disks by zpool import, not imported.
type zfsImportable struct {
	Name   string `json:"name"`
	GUID   string `json:"guid"`
	State  string `json:"state"`
	Status string `json:"status,omitempty"`
	// OtherHost: last used by another system; zpool import needs -f.
	OtherHost bool      `json:"otherHost"`
	Vdevs     []zfsVdev `json:"vdevs"`
}

type zfsPoolStatus struct {
	Vdevs  []zfsVdev
	Scan   zfsScan
	Expand zfsExpand
}

// zfsExpand: a raidz vdev widened by one disk (OpenZFS 2.3+), from the
// "expand:" lines of zpool status.
type zfsExpand struct {
	State string  `json:"state"` // running, finished, none
	Vdev  string  `json:"vdev,omitempty"`
	Pct   float64 `json:"pct,omitempty"`
}

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

// parseZpoolList reads `zpool list -Hp -o name,guid,size,allocated,free,fragmentation,health`.
func parseZpoolList(out string) []zfsPool {
	var pools []zfsPool
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 7 {
			continue
		}
		frag, _ := strconv.Atoi(strings.TrimSuffix(f[5], "%"))
		pools = append(pools, zfsPool{
			Name: f[0], GUID: f[1], Size: atoi64(f[2]), Alloc: atoi64(f[3]), Free: atoi64(f[4]),
			Frag: frag, State: strings.TrimSpace(f[6]), Vdevs: []zfsVdev{},
		})
	}
	return pools
}

// humanCount reads a zpool error counter: 12, 1.2K (thousands), 3M.
func humanCount(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, true
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'K':
		mult = 1e3
	case 'M':
		mult = 1e6
	case 'G':
		mult = 1e9
	}
	if mult != 1 {
		s = s[:len(s)-1]
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return int64(v * mult), true
}

var classHeaders = map[string]string{"logs": "log", "cache": "cache", "spares": "spare", "special": "special", "dedup": "special"}

// vdevType names a group from its name (mirror-0, raidz2-1, replacing-2).
func vdevType(name string) string {
	for _, p := range []string{"mirror", "raidz1", "raidz2", "raidz3", "replacing", "spare"} {
		if strings.HasPrefix(name, p+"-") {
			return p
		}
	}
	if strings.HasPrefix(name, "raidz-") {
		return "raidz1"
	}
	// draid2:4d:1c:6c-0: the digit after draid is the parity.
	if strings.HasPrefix(name, "draid") {
		if len(name) > 5 && name[5] >= '1' && name[5] <= '3' {
			return "draid" + string(name[5])
		}
		return "draid1"
	}
	return "disk"
}

// parseConfigTree reads the config table of zpool status or zpool import:
// one line per node, two spaces of indentation per level under a tab. The
// first node is the pool; class headers (logs, cache, spares) open a class
// for the top-level vdevs under them.
func parseConfigTree(lines []string) (pool zfsVdev, ok bool) {
	type frame struct {
		depth int
		node  *zfsVdev
	}
	var root *zfsVdev
	var stack []frame
	class := ""
	for _, raw := range lines {
		if !strings.HasPrefix(raw, "\t") {
			continue
		}
		line := strings.TrimPrefix(raw, "\t")
		f := strings.Fields(line)
		if len(f) == 0 || f[0] == "NAME" {
			continue
		}
		depth := (len(line) - len(strings.TrimLeft(line, " "))) / 2
		if depth == 0 && len(f) == 1 {
			if c, isClass := classHeaders[f[0]]; isClass && root != nil {
				class = c
				stack = stack[:1]
			}
			continue
		}
		n := zfsVdev{Name: f[0], Children: []zfsVdev{}}
		if len(f) > 1 {
			n.State = f[1]
		}
		// A missing device is printed by its guid, then "was /dev/...".
		for i := 2; i+1 < len(f); i++ {
			if f[i] == "was" && strings.HasPrefix(f[i+1], "/") {
				n.Path = f[i+1]
			}
		}
		if len(f) >= 5 {
			r, ok1 := humanCount(f[2])
			w, ok2 := humanCount(f[3])
			c, ok3 := humanCount(f[4])
			if ok1 && ok2 && ok3 {
				n.Read, n.Write, n.Checksum = r, w, c
			}
		}
		if depth == 0 {
			if root != nil {
				break
			}
			n.Type = "pool"
			root = &n
			stack = []frame{{0, root}}
			continue
		}
		if root == nil {
			continue
		}
		for len(stack) > 1 && stack[len(stack)-1].depth >= depth {
			stack = stack[:len(stack)-1]
		}
		parent := stack[len(stack)-1].node
		n.Type = vdevType(n.Name)
		if depth == 1 && class != "" {
			n.Type = class
		}
		if (n.Type == "disk" || (depth == 1 && class != "" && vdevType(n.Name) == "disk")) && n.Path == "" {
			n.Path = n.Name
		}
		parent.Children = append(parent.Children, n)
		stack = append(stack, frame{depth, &parent.Children[len(parent.Children)-1]})
	}
	if root == nil {
		return zfsVdev{}, false
	}
	return *root, true
}

var (
	reScanDone    = regexp.MustCompile(`^(scrub repaired|resilvered) (\S+) in \S+ with (\d+) errors on (.+)$`)
	reScanRunning = regexp.MustCompile(`^(scrub|resilver) in progress since (.+)$`)
	reScanCancel  = regexp.MustCompile(`^(scrub|resilver) canceled on (.+)$`)
	rePercentDone = regexp.MustCompile(`([\d.]+)% done`)
)

func parseScan(lines []string) zfsScan {
	s := zfsScan{Kind: "none", State: "none"}
	if len(lines) == 0 {
		return s
	}
	first := strings.TrimSpace(lines[0])
	switch {
	case reScanDone.MatchString(first):
		m := reScanDone.FindStringSubmatch(first)
		s.Kind, s.State, s.End = "scrub", "finished", m[4]
		if m[1] == "resilvered" {
			s.Kind = "resilver"
		}
		s.Repaired, _ = humanSize(m[2])
		s.Errors = atoi64(m[3])
	case reScanRunning.MatchString(first):
		m := reScanRunning.FindStringSubmatch(first)
		s.Kind, s.State, s.Start = m[1], "running", m[2]
		for _, l := range lines[1:] {
			if p := rePercentDone.FindStringSubmatch(l); p != nil {
				v, err := strconv.ParseFloat(p[1], 64)
				if err == nil {
					s.Percent = &v
				}
			}
		}
	case reScanCancel.MatchString(first):
		m := reScanCancel.FindStringSubmatch(first)
		s.Kind, s.State, s.End = m[1], "canceled", m[2]
	}
	return s
}

// humanSize reads a size with binary units (1.50M is 1.5 MiB).
func humanSize(s string) (int64, bool) {
	s = strings.TrimSuffix(strings.TrimSpace(s), "B")
	mult := 1.0
	if s != "" {
		switch s[len(s)-1] {
		case 'K':
			mult = 1 << 10
		case 'M':
			mult = 1 << 20
		case 'G':
			mult = 1 << 30
		case 'T':
			mult = 1 << 40
		}
		if mult != 1 {
			s = s[:len(s)-1]
		}
	}
	if s == "" {
		return 0, true
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return int64(v * mult), true
}

// keyedBlocks splits zpool status/import output into blocks, one per pool,
// each a map of its "key:" fields (with continuation lines) and its config
// lines.
type zpoolBlock struct {
	fields map[string][]string
	config []string
}

func keyedBlocks(out string) []zpoolBlock {
	var blocks []zpoolBlock
	var cur *zpoolBlock
	key := ""
	reKey := regexp.MustCompile(`^\s*([a-z]+):\s?(.*)$`)
	for _, line := range strings.Split(out, "\n") {
		if m := reKey.FindStringSubmatch(line); m != nil && !strings.HasPrefix(line, "\t") {
			if m[1] == "pool" {
				blocks = append(blocks, zpoolBlock{fields: map[string][]string{}})
				cur = &blocks[len(blocks)-1]
			}
			if cur == nil {
				continue
			}
			key = m[1]
			if v := strings.TrimSpace(m[2]); v != "" {
				cur.fields[key] = append(cur.fields[key], v)
			}
			continue
		}
		if cur == nil {
			continue
		}
		if key == "config" {
			cur.config = append(cur.config, line)
		} else if strings.HasPrefix(line, "\t") && key != "" {
			cur.fields[key] = append(cur.fields[key], strings.TrimSpace(line))
		}
	}
	return blocks
}

func blockField(f map[string][]string, k string) string {
	if v := f[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// parseZpoolStatus reads `zpool status -P`, by pool name.
func parseZpoolStatus(out string) map[string]zfsPoolStatus {
	res := map[string]zfsPoolStatus{}
	for _, b := range keyedBlocks(out) {
		name := blockField(b.fields, "pool")
		root, ok := parseConfigTree(b.config)
		vdevs := []zfsVdev{}
		if ok {
			vdevs = root.Children
		}
		res[name] = zfsPoolStatus{Vdevs: vdevs, Scan: parseScan(b.fields["scan"]), Expand: parseExpand(b.fields["expand"])}
	}
	return res
}

// parseZpoolImport reads `zpool import -d /dev/disk/by-id` (no pool named).
func parseZpoolImport(out string) []zfsImportable {
	var res []zfsImportable
	for _, b := range keyedBlocks(out) {
		root, _ := parseConfigTree(b.config)
		vdevs := root.Children
		if vdevs == nil {
			vdevs = []zfsVdev{}
		}
		res = append(res, zfsImportable{
			Name: blockField(b.fields, "pool"), GUID: blockField(b.fields, "id"), State: blockField(b.fields, "state"),
			Status: strings.Join(b.fields["status"], " "), Vdevs: vdevs,
			OtherHost: strings.Contains(strings.Join(b.fields["status"], " "), "another system"),
		})
	}
	return res
}

// parseZfsList reads `zfs list -Hp -t filesystem -o
// name,used,available,quota,mountpoint,mounted,compression,compressratio,canmount`.
func parseZfsList(out string) []zfsDataset {
	var ds []zfsDataset
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 8 {
			continue
		}
		quota := int64(0)
		if q := f[3]; q != "-" && q != "none" {
			quota = atoi64(q)
		}
		ratio, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(f[7]), "x"), 64)
		ds = append(ds, zfsDataset{
			Name: f[0], Pool: strings.SplitN(f[0], "/", 2)[0], Used: atoi64(f[1]), Avail: atoi64(f[2]), Quota: quota,
			MountPoint: f[4], Mounted: f[5] == "yes", Compression: f[6], Ratio: ratio, CanMount: "on",
		})
		if len(f) > 8 {
			ds[len(ds)-1].CanMount = strings.TrimSpace(f[8])
		}
	}
	return ds
}

// zfsDatasetIsVolume: a dataset ZFS mounts on a folder of its own by itself
// (canmount=on). none and legacy mount points, and container datasets
// (canmount off or noauto), never make a volume.
func zfsDatasetIsVolume(d zfsDataset) bool {
	return strings.HasPrefix(d.MountPoint, "/") && d.CanMount == "on"
}

// parseZfsVersion reads `zfs version`: zfs-2.2.2-0ubuntu9.1 gives 2.2.2.
func parseZfsVersion(out string) string {
	line := strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
	line = strings.TrimPrefix(line, "zfs-")
	return strings.SplitN(line, "-", 2)[0]
}

// wholeDiskOf names the whole disk under a leaf's device path: links are
// resolved, then a partition gives its parent disk (sdb1 -> sdb).
func wholeDiskOf(path string, resolve func(string) (string, error), parentOf func(string) string) string {
	real, err := resolve(path)
	if err != nil {
		real = path
	}
	name := filepath.Base(real)
	if p := parentOf(name); p != "" {
		return p
	}
	return name
}

// ── Reading the host ─────────────────────────────────────────────────────────

// zfsAvailable: the zfs module is loaded and its commands are installed.
var zfsAvailable = func() bool {
	if _, err := os.Stat("/sys/module/zfs"); err != nil {
		return false
	}
	for _, c := range []string{"zpool", "zfs"} {
		if _, err := exec.LookPath(c); err != nil {
			return false
		}
	}
	return true
}

// zfsResolve and zfsParentOf find a leaf's whole disk; tests swap them.
var (
	zfsResolve  = filepath.EvalSymlinks
	zfsParentOf = func(name string) string {
		if _, err := os.Stat("/sys/class/block/" + name + "/partition"); err != nil {
			return ""
		}
		real, err := filepath.EvalSymlinks("/sys/class/block/" + name)
		if err != nil {
			return ""
		}
		return filepath.Base(filepath.Dir(real))
	}
)

type zfsInfo struct {
	Available bool `json:"available"`
	// Complete: every pool read succeeded; alerts close only on a complete reading.
	Complete bool `json:"complete"`
	// BootUnits: the distribution's units that import and mount pools at boot.
	BootUnits zfsBootUnits  `json:"bootUnits"`
	Version   string        `json:"version"`
	Pools     []zfsPool     `json:"pools"`
	Datasets  []zfsDataset  `json:"datasets"`
	Watched   []watchedPool `json:"watched"`
}

func fillDisks(vs []zfsVdev) {
	for i := range vs {
		if vs[i].Path != "" {
			path := vs[i].Path
			if !strings.HasPrefix(path, "/") {
				path = "/dev/disk/by-id/" + path
			}
			vs[i].Disk = wholeDiskOf(path, zfsResolve, zfsParentOf)
		}
		fillDisks(vs[i].Children)
	}
}

type zfsBootUnits struct {
	ImportCache bool `json:"importCache"`
	Mount       bool `json:"mount"`
}

// zfsUnitStates asks systemd whether the boot units are enabled (tests swap it).
var zfsUnitStates = func() string {
	out, _ := probe("systemctl", "is-enabled", "zfs-import-cache.service", "zfs-mount.service").Output()
	return string(out)
}

// parseBootUnits reads `systemctl is-enabled zfs-import-cache.service
// zfs-mount.service`: one state per line, in that order.
func parseBootUnits(out string) (importCache, mount bool) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	at := func(i int) bool { return i < len(lines) && strings.TrimSpace(lines[i]) == "enabled" }
	return at(0), at(1)
}

// zfsSnapshot reads every pool and filesystem dataset. Without ZFS it runs
// nothing and says so.
func zfsSnapshot() zfsInfo {
	info := zfsInfo{Pools: []zfsPool{}, Datasets: []zfsDataset{}, Watched: loadWatchedPools()}
	if !zfsAvailable() {
		return info
	}
	info.Available = true
	// is-enabled exits non-zero when a unit is disabled: the output still says which.
	info.BootUnits.ImportCache, info.BootUnits.Mount = parseBootUnits(zfsUnitStates())
	if out, err := hostOutput("zfs", "version"); err == nil {
		info.Version = parseZfsVersion(string(out))
	}
	info.Complete = true
	if out, err := hostOutput("zpool", "list", "-Hp", "-o", "name,guid,size,allocated,free,fragmentation,health"); err == nil {
		info.Pools = parseZpoolList(string(out))
	} else {
		info.Complete = false
	}
	if info.Pools == nil {
		info.Pools = []zfsPool{}
	}
	if len(info.Pools) > 0 {
		out, err := hostOutput("zpool", "status", "-P")
		if err != nil {
			info.Complete = false
		}
		if err == nil {
			st := parseZpoolStatus(string(out))
			for i := range info.Pools {
				if s, ok := st[info.Pools[i].Name]; ok {
					info.Pools[i].Vdevs, info.Pools[i].Scan, info.Pools[i].Expand = s.Vdevs, s.Scan, s.Expand
				}
				fillDisks(info.Pools[i].Vdevs)
			}
		}
	}
	if len(info.Pools) > 0 {
		if out, err := hostOutput("zpool", "list", "-Hp", "-o", "name,expandsize"); err == nil {
			sizes := parseExpandSizes(string(out))
			for i := range info.Pools {
				info.Pools[i].ExpandSize = sizes[info.Pools[i].Name]
			}
		}
	}
	if out, err := hostOutput("zfs", "list", "-Hp", "-t", "filesystem", "-o", "name,used,available,quota,mountpoint,mounted,compression,compressratio,canmount"); err == nil {
		info.Datasets = parseZfsList(string(out))
	}
	if info.Datasets == nil {
		info.Datasets = []zfsDataset{}
	}
	return info
}

// zfsImportScan lists the pools on the disks that are not imported. zpool
// exits 1 with "no pools available to import" when there is none.
func zfsImportScan() []zfsImportable {
	if !zfsAvailable() {
		return []zfsImportable{}
	}
	out, _ := hostOutput("zpool", "import", "-d", "/dev/disk/by-id")
	pools := parseZpoolImport(string(out))
	for i := range pools {
		fillDisks(pools[i].Vdevs)
	}
	if pools == nil {
		pools = []zfsImportable{}
	}
	return pools
}

func handleZfsList(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, zfsSnapshot())
}

func handleZfsImportScan(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"pools": zfsImportScan()})
}
