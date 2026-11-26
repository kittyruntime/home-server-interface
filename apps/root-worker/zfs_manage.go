package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// ── ZFS lot 2: create and delete pools and datasets ──────────────────────────
// Every change is a plan, like the LVM ones: the exact commands, the disks a
// step erases, and the watched pools file with its diff.

// zfsLayouts: the minimum number of disks of each pool layout.
var zfsLayouts = map[string]int{"stripe": 1, "mirror": 2, "raidz1": 3, "raidz2": 4, "raidz3": 5}

var zfsCompressions = map[string]bool{"lz4": true, "zstd": true, "off": true}

// zfsPoolNames lists the imported pools by name.
func zfsPoolNames() []string {
	out, err := hostOutput("zpool", "list", "-Hp", "-o", "name,guid,size,allocated,free,fragmentation,health")
	if err != nil {
		return nil
	}
	var names []string
	for _, p := range parseZpoolList(string(out)) {
		names = append(names, p.Name)
	}
	return names
}

var reReservedPool = regexp.MustCompile(`^(mirror|raidz|draid|spare|log|cache|special|dedup)|^c[0-9]`)

// reservedPoolName: names zpool refuses (vdev keywords, and c<digit> device names).
func reservedPoolName(name string) bool {
	return reReservedPool.MatchString(name)
}

// watchAfter is the deferred step that watches a pool once it exists, with the
// datasets it mounts.
func watchAfter(name string) planStep {
	return planStep{Kind: "update", Target: zfsPoolsPath, Deferred: true,
		Summary: "Watch " + name + ": its datasets are guarded like any HSI volume",
		run: func() (string, error) {
			w, ok := watchEntry(name)
			if !ok {
				return "", cmdError{"the pool " + name + " is not imported"}
			}
			before := string(marshalWatched(loadWatchedPools()))
			next := withWatched(loadWatchedPools(), w)
			if err := saveWatched(next); err != nil {
				return "", err
			}
			return unifiedDiff(zfsPoolsPath, before, string(marshalWatched(next))), nil
		}}
}

func planZfsPoolCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name        string   `json:"name"`
		Layout      string   `json:"layout"`
		Disks       []string `json:"disks"`
		Compression string   `json:"compression"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !zfsAvailable() {
		return nil, &fsError{Code: "ENOTOOL", Message: "ZFS is not available on this server"}
	}
	if !reZpoolName.MatchString(req.Name) || systemTopLevel[req.Name] || reservedPoolName(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool name: use letters, digits, - _ . :, not the name of a system folder nor a name ZFS reserves (mirror, raidz, draid, spare, log, cache, special, dedup, c0...)"}
	}
	for _, n := range zfsPoolNames() {
		if n == req.Name {
			return nil, &fsError{Code: "EEXIST", Message: "a pool named " + req.Name + " already exists"}
		}
	}
	min, ok := zfsLayouts[req.Layout]
	if !ok {
		return nil, &fsError{Code: "ERR", Message: "unsupported layout " + req.Layout}
	}
	if len(req.Disks) < min {
		return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("%s needs at least %d disks (got %d)", req.Layout, min, len(req.Disks))}
	}
	if !zfsCompressions[req.Compression] {
		return nil, &fsError{Code: "ERR", Message: "unsupported compression " + req.Compression}
	}
	mp := "/srv/" + req.Name
	if hostExists(mp) && !hostDirEmpty(mp) {
		return nil, &fsError{Code: "ERR", Message: mp + " is not empty; choose another name"}
	}
	if !mountPointAllowed(mp, req.Name, zfsMountTable(), filepath.EvalSymlinks) {
		return nil, &fsError{Code: "EEXIST", Message: mp + " is already in use; choose another name"}
	}

	sys := hostSystemDevs()
	ids := preferredByID(hostByIDLinks())
	obs := map[string]string{"pools": strings.Join(zfsPoolNames(), ",")}
	seen := map[string]bool{}
	var devs, vdev []string
	for _, d := range req.Disks {
		if !reBlockDev.MatchString(d) {
			return nil, &fsError{Code: "ERR", Message: "invalid device name: " + d}
		}
		if seen[d] {
			return nil, &fsError{Code: "ERR", Message: d + " is listed twice"}
		}
		seen[d] = true
		if sys[d] {
			return nil, &fsError{Code: "ESYS", Message: "device " + d + " belongs to the system disk"}
		}
		if !hostWholeDisk(d) {
			return nil, &fsError{Code: "ERR", Message: d + " is not a whole disk; a pool is built from whole disks"}
		}
		if fe := hostClaimable(d); fe != nil {
			return nil, fe
		}
		devs = append(devs, "/dev/"+d)
		observeDevice(obs, "/dev/"+d, "/dev/"+d)
		// A stable name: the pool finds its disks again whatever their kernel names.
		if id := ids[d]; id != "" {
			vdev = append(vdev, "/dev/disk/by-id/"+id)
		} else {
			vdev = append(vdev, "/dev/"+d)
		}
	}
	argv := []string{"zpool", "create", "-o", "ashift=12", "-O", "compression=" + req.Compression,
		"-O", "atime=off", "-O", "xattr=sa", "-O", "acltype=posixacl", "-m", mp, req.Name}
	if req.Layout != "stripe" {
		argv = append(argv, req.Layout)
	}
	argv = append(argv, vdev...)
	create := destructiveAll(cmdStep(req.Name,
		fmt.Sprintf("Create the ZFS pool %s (%s) on %s, erasing their contents, mounted on %s", req.Name, req.Layout, strings.Join(devs, ", "), mp), argv), devs)
	return &opPlan{Op: "zfs.pool.create", Steps: []planStep{create, watchAfter(req.Name)}, Observed: obs}, nil
}

type diskPart struct{ Name, FSType string }

// zfsDiskParts lists the partitions of a disk with their filesystem type
// (tests swap it).
var zfsDiskParts = func(disk string) []diskPart {
	out, err := hostOutput("lsblk", "-nr", "-o", "NAME,TYPE,FSTYPE", "/dev/"+disk)
	if err != nil {
		return nil
	}
	var parts []diskPart
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[1] == "part" {
			p := diskPart{Name: f[0]}
			if len(f) > 2 {
				p.FSType = f[2]
			}
			parts = append(parts, p)
		}
	}
	return parts
}

// zfsWipeTargets: what to erase once a pool is destroyed so its disks show as
// free, and only that. A leaf counts when it is online (or an available
// spare not shared with another pool), resolves to a device of this host, and
// carries this pool's label (blkid TYPE zfs_member, UUID the pool guid). The
// whole disk is wiped only when every partition on it is this pool's (the
// layout zpool makes on a whole disk: the data partition and the small
// reserved partition 9); otherwise only the pool's partitions are. Nothing on
// the system disk is touched.
func zfsWipeTargets(pool zfsPool, others []zfsPool) (wipes []string, disks []string) {
	sys := hostSystemDevs()
	sharedSpare := map[string]bool{}
	for _, o := range others {
		for _, top := range o.Vdevs {
			if top.Type == "spare" {
				for _, l := range leavesOf(top) {
					if real, err := zfsResolve(l.Path); err == nil {
						sharedSpare[filepath.Base(real)] = true
					}
				}
			}
		}
	}
	leavesByDisk := map[string][]string{}
	seenDisk := map[string]bool{}
	var order []string
	for _, top := range pool.Vdevs {
		spare := top.Type == "spare"
		for _, l := range leavesOf(top) {
			if !(l.State == "ONLINE" || (spare && l.State == "AVAIL")) || !strings.HasPrefix(l.Path, "/") {
				continue
			}
			real, err := zfsResolve(l.Path)
			if err != nil || real == "" {
				continue
			}
			name := filepath.Base(real)
			if !reBlockDev.MatchString(name) || (spare && sharedSpare[name]) {
				continue
			}
			if hostBlkid("/dev/"+name, "TYPE") != "zfs_member" || hostBlkid("/dev/"+name, "UUID") != pool.GUID {
				continue
			}
			disk := zfsParentOf(name)
			if disk == "" {
				disk = name
			}
			if sys[disk] || sys[name] {
				continue
			}
			if !seenDisk[disk] {
				seenDisk[disk] = true
				order = append(order, disk)
			}
			if name != disk {
				leavesByDisk[disk] = append(leavesByDisk[disk], name)
			}
		}
	}
	for _, disk := range order {
		mine := map[string]bool{}
		for _, p := range leavesByDisk[disk] {
			mine[p] = true
			wipes = append(wipes, p)
		}
		whole := true
		for _, p := range zfsDiskParts(disk) {
			if !mine[p.Name] && !(p.FSType == "" && strings.HasSuffix(p.Name, "9")) {
				whole = false
			}
		}
		if whole {
			wipes = append(wipes, disk)
			disks = append(disks, disk)
		}
	}
	return wipes, disks
}

func leavesOf(v zfsVdev) []zfsVdev {
	if len(v.Children) == 0 {
		return []zfsVdev{v}
	}
	var out []zfsVdev
	for _, c := range v.Children {
		out = append(out, leavesOf(c)...)
	}
	return out
}

func planZfsPoolDestroy(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil || !reZpoolName.MatchString(req.Name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool"}
	}
	info := zfsSnapshot()
	var pool *zfsPool
	var others []zfsPool
	for i := range info.Pools {
		if info.Pools[i].Name == req.Name {
			pool = &info.Pools[i]
		} else {
			others = append(others, info.Pools[i])
		}
	}
	if pool == nil {
		return nil, &fsError{Code: "ENOENT", Message: "The pool " + req.Name + " is not imported"}
	}
	wipes, disks := zfsWipeTargets(*pool, others)
	var devs []string
	for _, w := range wipes {
		devs = append(devs, "/dev/"+w)
	}
	obs := map[string]string{"pool": pool.GUID}
	for _, d := range devs {
		observeDevice(obs, d, d)
	}
	diskDevs := []string{}
	for _, d := range disks {
		diskDevs = append(diskDevs, "/dev/"+d)
	}
	steps := []planStep{destructiveAll(cmdStep(req.Name,
		"Destroy the ZFS pool "+req.Name+" and every dataset and file in it", []string{"zpool", "destroy", req.Name}), diskDevs),
		// Unwatched at once: a pool that is gone must not be reported missing.
		watchedStep("Stop watching "+req.Name, withoutWatched(loadWatchedPools(), req.Name))}
	// Wiped so that the disks show as free again; a wipe that fails only warns.
	for _, w := range wipes {
		summary := "Erase the ZFS signature of /dev/" + w
		if containsString(disks, w) {
			summary = "Erase the partition table of /dev/" + w + " so it shows as a free disk"
		}
		s := cmdStep("/dev/"+w, summary, []string{"wipefs", "-a", "/dev/" + w})
		s.OnFailure = "warn"
		steps = append(steps, s)
	}
	return &opPlan{Op: "zfs.pool.destroy", Steps: steps, Observed: obs}, nil
}

var reZfsSegment = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// splitDataset checks a child dataset name (pool/a/b) and returns its pool,
// its parent and its last part.
func splitDataset(name string) (pool, parent, last string, ok bool) {
	segs := strings.Split(name, "/")
	if len(segs) < 2 || !reZpoolName.MatchString(segs[0]) {
		return "", "", "", false
	}
	for _, s := range segs[1:] {
		if !reZfsSegment.MatchString(s) || s == "." || s == ".." {
			return "", "", "", false
		}
	}
	return segs[0], strings.Join(segs[:len(segs)-1], "/"), segs[len(segs)-1], true
}

func findDataset(ds []zfsDataset, name string) *zfsDataset {
	for i := range ds {
		if ds[i].Name == name {
			return &ds[i]
		}
	}
	return nil
}

func isWatchedPool(name string) bool {
	for _, w := range loadWatchedPools() {
		if w.Name == name {
			return true
		}
	}
	return false
}

func planZfsDatasetCreate(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name        string `json:"name"`
		Quota       int64  `json:"quota"`
		Compression string `json:"compression"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	pool, parent, last, ok := splitDataset(req.Name)
	if !ok {
		return nil, &fsError{Code: "ERR", Message: "invalid dataset name: pool/name, with letters, digits, - _ . :"}
	}
	if req.Quota < 0 {
		return nil, &fsError{Code: "ERR", Message: "the quota cannot be negative"}
	}
	if req.Compression != "" && req.Compression != "inherit" && !zfsCompressions[req.Compression] {
		return nil, &fsError{Code: "ERR", Message: "unsupported compression " + req.Compression}
	}
	info := zfsSnapshot()
	if findDataset(info.Datasets, req.Name) != nil {
		return nil, &fsError{Code: "EEXIST", Message: req.Name + " already exists"}
	}
	par := findDataset(info.Datasets, parent)
	if par == nil {
		return nil, &fsError{Code: "ENOENT", Message: parent + " does not exist"}
	}
	mp := ""
	if strings.HasPrefix(par.MountPoint, "/") {
		mp = par.MountPoint + "/" + last
		if !mountPointAllowed(mp, pool, zfsMountTable(), filepath.EvalSymlinks) {
			return nil, &fsError{Code: "ERR", Message: mp + " is outside the data folders or already in use"}
		}
		if hostExists(mp) && !hostDirEmpty(mp) {
			return nil, &fsError{Code: "ERR", Message: mp + " is not empty: ZFS would not mount the new dataset there; choose another name"}
		}
	}
	argv := []string{"zfs", "create"}
	if req.Quota > 0 {
		argv = append(argv, "-o", fmt.Sprintf("quota=%d", req.Quota))
	}
	if zfsCompressions[req.Compression] {
		argv = append(argv, "-o", "compression="+req.Compression)
	}
	argv = append(argv, req.Name)
	summary := "Create the dataset " + req.Name
	if mp != "" {
		summary += ", mounted on " + mp
	}
	steps := []planStep{cmdStep(req.Name, summary, argv)}
	if mp != "" && isWatchedPool(pool) {
		next := []watchedPool{}
		for _, w := range loadWatchedPools() {
			if w.Name == pool {
				w.Datasets = append(append([]watchedDataset{}, w.Datasets...), watchedDataset{Name: req.Name, MountPoint: mp})
			}
			next = append(next, w)
		}
		steps = append(steps, watchedStep("Guard "+req.Name+" with the rest of "+pool, next))
	}
	return &opPlan{Op: "zfs.dataset.create", Steps: steps, Observed: map[string]string{}}, nil
}

func planZfsDatasetSet(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name        string `json:"name"`
		Quota       int64  `json:"quota"`
		Compression string `json:"compression"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if req.Quota < 0 || !zfsCompressions[req.Compression] {
		return nil, &fsError{Code: "ERR", Message: "invalid quota or compression"}
	}
	if findDataset(zfsSnapshot().Datasets, req.Name) == nil {
		return nil, &fsError{Code: "ENOENT", Message: req.Name + " does not exist"}
	}
	quota := "none"
	if req.Quota > 0 {
		quota = fmt.Sprint(req.Quota)
	}
	s := cmdStep(req.Name, "Set the quota ("+quota+") and the compression ("+req.Compression+") of "+req.Name,
		[]string{"zfs", "set", "quota=" + quota, "compression=" + req.Compression, req.Name})
	return &opPlan{Op: "zfs.dataset.set", Steps: []planStep{s}, Observed: map[string]string{}}, nil
}

func planZfsDatasetDestroy(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	pool, _, _, ok := splitDataset(req.Name)
	if !ok {
		return nil, &fsError{Code: "ERR", Message: "invalid dataset: a pool is deleted as a whole"}
	}
	info := zfsSnapshot()
	if findDataset(info.Datasets, req.Name) == nil {
		return nil, &fsError{Code: "ENOENT", Message: req.Name + " does not exist"}
	}
	// Children of every kind: datasets, zvols and snapshots.
	if out, err := hostOutput("zfs", "list", "-H", "-o", "name", "-t", "all", "-r", req.Name); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			n := strings.SplitN(line, "\t", 2)[0]
			if strings.HasPrefix(n, req.Name+"/") || strings.HasPrefix(n, req.Name+"@") {
				return nil, &fsError{Code: "ERR", Message: req.Name + " holds " + n + ": delete it first"}
			}
		}
	}
	for _, d := range info.Datasets {
		if strings.HasPrefix(d.Name, req.Name+"/") {
			return nil, &fsError{Code: "ERR", Message: req.Name + " has datasets inside (" + d.Name + "): delete them first"}
		}
	}
	del := cmdStep(req.Name, "Destroy the dataset "+req.Name+" and every file in it", []string{"zfs", "destroy", req.Name})
	del.Destructive = true
	steps := []planStep{del}
	if isWatchedPool(pool) {
		next := []watchedPool{}
		for _, w := range loadWatchedPools() {
			if w.Name == pool {
				kept := []watchedDataset{}
				for _, d := range w.Datasets {
					if d.Name != req.Name {
						kept = append(kept, d)
					}
				}
				w.Datasets = kept
			}
			next = append(next, w)
		}
		steps = append(steps, watchedStep("Stop guarding "+req.Name, next))
	}
	return &opPlan{Op: "zfs.dataset.destroy", Steps: steps, Observed: map[string]string{}}, nil
}
