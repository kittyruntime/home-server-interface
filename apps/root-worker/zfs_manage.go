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
	if !reZpoolName.MatchString(req.Name) || systemTopLevel[req.Name] {
		return nil, &fsError{Code: "ERR", Message: "invalid pool name: use letters, digits, - _ . : and not the name of a system folder"}
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

// zfsPoolDisks: the whole disks of a pool and the partitions ZFS made on them
// (sdf1), from its leaves.
func zfsPoolDisks(p zfsPool) (disks []string, parts map[string][]string) {
	parts = map[string][]string{}
	seen := map[string]bool{}
	var walk func(vs []zfsVdev)
	walk = func(vs []zfsVdev) {
		for _, v := range vs {
			if len(v.Children) == 0 && v.Disk != "" {
				if !seen[v.Disk] {
					seen[v.Disk] = true
					disks = append(disks, v.Disk)
				}
				if real, err := zfsResolve(v.Path); err == nil && real != "" {
					if part := filepath.Base(real); part != v.Disk && reBlockDev.MatchString(part) {
						parts[v.Disk] = append(parts[v.Disk], part)
					}
				}
			}
			walk(v.Children)
		}
	}
	walk(p.Vdevs)
	return disks, parts
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
	for i := range info.Pools {
		if info.Pools[i].Name == req.Name {
			pool = &info.Pools[i]
		}
	}
	if pool == nil {
		return nil, &fsError{Code: "ENOENT", Message: "The pool " + req.Name + " is not imported"}
	}
	disks, parts := zfsPoolDisks(*pool)
	var devs []string
	for _, d := range disks {
		devs = append(devs, "/dev/"+d)
	}
	obs := map[string]string{"pool": pool.GUID}
	for _, d := range devs {
		observeDevice(obs, d, d)
	}
	steps := []planStep{destructiveAll(cmdStep(req.Name,
		"Destroy the ZFS pool "+req.Name+" and every dataset and file in it", []string{"zpool", "destroy", req.Name}), devs)}
	// Wiped so that the disks show as free again.
	for _, d := range disks {
		for _, p := range parts[d] {
			steps = append(steps, cmdStep("/dev/"+p, "Erase the ZFS signature of /dev/"+p, []string{"wipefs", "-a", "/dev/" + p}))
		}
		steps = append(steps, cmdStep("/dev/"+d, "Erase the partition table of /dev/"+d+" so it shows as a free disk", []string{"wipefs", "-a", "/dev/" + d}))
	}
	steps = append(steps, watchedStep("Stop watching "+req.Name, withoutWatched(loadWatchedPools(), req.Name)))
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
