package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
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

// zfsNow is the clock of the scrub task (tests swap it).
var zfsNow = time.Now

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
		switch {
		case st == nil:
			// Whether a scrub or a resilver runs is unknown: start nothing, retry later.
			results = append(results, taskResult{Device: p.Name, Status: "skipped", Message: "zpool status could not be read"})
			continue
		case p.State != "ONLINE" && p.State != "DEGRADED":
			results = append(results, taskResult{Device: p.Name, Status: "skipped", Message: "the pool is " + p.State})
			continue
		case st[p.Name].Scan.State == "running":
			results = append(results, taskResult{Device: p.Name, Status: "skipped", Message: "a " + st[p.Name].Scan.Kind + " is running"})
			continue
		}
		started := zfsNow().UTC().Format(time.RFC3339)
		if out, err := runArgv([]string{"zpool", "scrub", p.Name}); err != nil {
			results = append(results, taskResult{Device: p.Name, PoolGUID: p.GUID, Status: "error", Message: cmdErrMessage(out, err)})
			continue
		}
		results = append(results, taskResult{Device: p.Name, PoolGUID: p.GUID, StartedAt: started, Status: "started"})
	}
	return results
}

// zpoolTime reads a time as zpool status prints it (Wed Nov 25 10:00:00 2026).
func zpoolTime(s string) (time.Time, bool) {
	t, err := time.ParseInLocation("Mon Jan 2 15:04:05 2006", strings.Join(strings.Fields(s), " "), time.Local)
	return t, err == nil
}

// refreshScrubResults reads back the scrubs a run started, by the pool's
// guid: running, then passed, failed (errors found) or canceled; unknown when
// the pool is gone. A scan that ended before the run started is an older one.
func refreshScrubResults(results []taskResult) []taskResult {
	pending := false
	for _, r := range results {
		pending = pending || r.Status == "started"
	}
	if !pending {
		return results
	}
	byGUID := map[string]string{}
	if out, err := hostOutput("zpool", "list", "-Hp", "-o", "name,guid,size,allocated,free,fragmentation,health"); err == nil {
		for _, p := range parseZpoolList(string(out)) {
			byGUID[p.GUID] = p.Name
		}
	}
	st := zpoolStatuses()
	out := make([]taskResult, len(results))
	for i, r := range results {
		out[i] = r
		if r.Status != "started" || st == nil {
			continue
		}
		name := r.Device
		if r.PoolGUID != "" {
			n, ok := byGUID[r.PoolGUID]
			if !ok {
				out[i].Status, out[i].Message = "unknown", "the pool is not imported now"
				continue
			}
			name = n
		}
		s, ok := st[name]
		if !ok {
			continue
		}
		since, hasSince := time.Time{}, false
		if r.StartedAt != "" {
			since, hasSince = func() (time.Time, bool) { t, err := time.Parse(time.RFC3339, r.StartedAt); return t, err == nil }()
		}
		ended := func() bool {
			if !hasSince {
				return true
			}
			end, ok := zpoolTime(s.Scan.End)
			return ok && !end.Before(since)
		}
		startedAfter := func() bool {
			start, ok := zpoolTime(s.Scan.Start)
			return hasSince && ok && !start.Before(since)
		}
		switch {
		case s.Scan.Kind == "scrub" && s.Scan.State == "running":
			out[i].Status = "running"
		case s.Scan.Kind == "resilver" && s.Scan.State == "running" && !startedAfter():
			out[i].Status = "running" // a resilver from before the run (it was skipped)
		case s.Scan.Kind == "resilver" && (startedAfter() || (s.Scan.State != "running" && ended())):
			out[i].Status, out[i].Message = "canceled", "a resilver took its place"
		case s.Scan.Kind == "scrub" && s.Scan.State == "canceled" && ended():
			out[i].Status = "canceled"
		case s.Scan.Kind == "scrub" && s.Scan.State == "finished" && ended() && s.Scan.Errors > 0:
			out[i].Status = "failed"
			out[i].Message = strconv.FormatInt(s.Scan.Errors, 10) + " errors found"
		case s.Scan.Kind == "scrub" && s.Scan.State == "finished" && ended():
			out[i].Status = "passed"
		}
	}
	return out
}

// settledChanged: a result went from started to an outcome that will not
// change (passed, failed, canceled, unknown).
func settledChanged(before, after []taskResult) bool {
	for i := range after {
		if i < len(before) && before[i].Status == "started" && after[i].Status != "started" && after[i].Status != "running" {
			return true
		}
	}
	return false
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
	if !replaceableLeaf(pool.Vdevs, req.Leaf) {
		return nil, &fsError{Code: "ERR", Message: req.Leaf + " is not a disk of " + req.Pool + " that can be replaced (not a cache or spare device, not already being replaced)"}
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

// replaceableLeaf: a data, log or special disk of the pool, not a cache or a
// hot spare, and not inside a replacement or a spare already in use.
func replaceableLeaf(vs []zfsVdev, leaf string) bool {
	var walk func(vs []zfsVdev, parent string) bool
	walk = func(vs []zfsVdev, parent string) bool {
		for _, v := range vs {
			if len(v.Children) == 0 && v.Name == leaf {
				return (v.Type == "disk" || v.Type == "log" || v.Type == "special") && parent != "replacing" && parent != "spare"
			}
			if walk(v.Children, v.Type) {
				return true
			}
		}
		return false
	}
	return walk(vs, "")
}
