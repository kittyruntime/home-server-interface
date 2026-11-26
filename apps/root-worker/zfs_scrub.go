package main

import (
	"encoding/json"
	"strconv"
)

// ZFS lot 3: the scheduled scrub, a maintenance task like the SMART tests and
// the RAID check. It starts `zpool scrub` on every imported pool that is not
// already scrubbing or resilvering; the outcome is read back from zpool status.

func zpoolStatuses() map[string]zfsPoolStatus {
	out, err := hostOutput("zpool", "status", "-P")
	if err != nil {
		return nil
	}
	return parseZpoolStatus(string(out))
}

func runZfsScrubs() []taskResult {
	if !zfsAvailable() {
		return []taskResult{{Device: "zfs", Status: "skipped", Message: "ZFS is not available on this server"}}
	}
	out, err := hostOutput("zpool", "list", "-Hp", "-o", "name,guid,size,allocated,free,fragmentation,health")
	if err != nil {
		return []taskResult{{Device: "zfs", Status: "error", Message: "could not list the pools: " + err.Error()}}
	}
	pools := parseZpoolList(string(out))
	if len(pools) == 0 {
		return []taskResult{{Device: "zfs", Status: "skipped", Message: "no pool is imported"}}
	}
	st := zpoolStatuses()
	results := []taskResult{}
	for _, p := range pools {
		if s, ok := st[p.Name]; ok && s.Scan.State == "running" {
			results = append(results, taskResult{Device: p.Name, Status: "skipped", Message: "a " + s.Scan.Kind + " is running"})
			continue
		}
		if out, err := runArgv([]string{"zpool", "scrub", p.Name}); err != nil {
			results = append(results, taskResult{Device: p.Name, Status: "error", Message: cmdErrMessage(out, err)})
			continue
		}
		results = append(results, taskResult{Device: p.Name, Status: "started"})
	}
	return results
}

// refreshScrubResults reads back the scrubs a run started: running while the
// pool still scrubs, then passed or failed (errors found).
func refreshScrubResults(results []taskResult) []taskResult {
	st := zpoolStatuses()
	out := make([]taskResult, len(results))
	for i, r := range results {
		out[i] = r
		s, ok := st[r.Device]
		if r.Status != "started" || !ok || s.Scan.Kind != "scrub" && s.Scan.Kind != "resilver" {
			continue
		}
		switch {
		case s.Scan.State == "running":
			out[i].Status = "running"
		case s.Scan.State == "finished" && s.Scan.Errors > 0:
			out[i].Status = "failed"
			out[i].Message = strconv.FormatInt(s.Scan.Errors, 10) + " errors found"
		case s.Scan.State == "finished":
			out[i].Status = "passed"
		}
	}
	return out
}

// ── Plans: scrub now or stop, replace a disk, clear errors ───────────────────

func importedPool(name string) (*zfsPool, *fsError) {
	if !reZpoolName.MatchString(name) {
		return nil, &fsError{Code: "ERR", Message: "invalid pool"}
	}
	for _, p := range zfsSnapshot().Pools {
		if p.Name == name {
			return &p, nil
		}
	}
	return nil, &fsError{Code: "ENOENT", Message: "The pool " + name + " is not imported"}
}

func planZfsScrub(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Pool string `json:"pool"`
		Stop bool   `json:"stop"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if _, fe := importedPool(req.Pool); fe != nil {
		return nil, fe
	}
	s := cmdStep(req.Pool, "Check every block of "+req.Pool+" against its checksum, repairing what the redundancy allows (the pool stays usable)",
		[]string{"zpool", "scrub", req.Pool})
	if req.Stop {
		s = cmdStep(req.Pool, "Stop the scrub of "+req.Pool, []string{"zpool", "scrub", "-s", req.Pool})
	}
	return &opPlan{Op: "zfs.scrub", Steps: []planStep{s}, Observed: map[string]string{}}, nil
}

func planZfsClear(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Pool string `json:"pool"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if _, fe := importedPool(req.Pool); fe != nil {
		return nil, fe
	}
	s := cmdStep(req.Pool, "Reset the read, write and checksum error counts of "+req.Pool+" (once their cause is fixed)",
		[]string{"zpool", "clear", req.Pool})
	return &opPlan{Op: "zfs.clear", Steps: []planStep{s}, Observed: map[string]string{}}, nil
}

// planZfsReplace replaces a leaf of a pool (named as zpool prints it: its
// path, or its guid when it is missing) with a free whole disk. ZFS then
// resilvers the new disk from the others.
func planZfsReplace(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Pool string `json:"pool"`
		Leaf string `json:"leaf"`
		Disk string `json:"disk"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	pool, fe := importedPool(req.Pool)
	if fe != nil {
		return nil, fe
	}
	found := false
	for _, top := range pool.Vdevs {
		for _, l := range leavesOf(top) {
			if l.Name == req.Leaf && len(l.Children) == 0 && l.Type == "disk" {
				found = true
			}
		}
	}
	if !found {
		return nil, &fsError{Code: "ERR", Message: req.Leaf + " is not a disk of " + req.Pool}
	}
	d := req.Disk
	if !reBlockDev.MatchString(d) {
		return nil, &fsError{Code: "ERR", Message: "invalid device name: " + d}
	}
	if hostSystemDevs()[d] {
		return nil, &fsError{Code: "ESYS", Message: "device " + d + " belongs to the system disk"}
	}
	if !hostWholeDisk(d) {
		return nil, &fsError{Code: "ERR", Message: d + " is not a whole disk"}
	}
	if fe := hostClaimable(d); fe != nil {
		return nil, fe
	}
	target := "/dev/" + d
	if id := preferredByID(hostByIDLinks())[d]; id != "" {
		target = "/dev/disk/by-id/" + id
	}
	obs := map[string]string{"pool": pool.GUID}
	observeDevice(obs, "/dev/"+d, "/dev/"+d)
	s := destructiveAll(cmdStep(req.Pool,
		"Replace "+req.Leaf+" in "+req.Pool+" with /dev/"+d+", erasing it; ZFS then rebuilds its data from the other disks (resilver)",
		[]string{"zpool", "replace", req.Pool, req.Leaf, target}), []string{"/dev/" + d})
	return &opPlan{Op: "zfs.replace", Steps: []planStep{s}, Observed: obs}, nil
}
