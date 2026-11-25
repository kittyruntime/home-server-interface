package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
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
