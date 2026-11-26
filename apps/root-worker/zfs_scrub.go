package main

import "strconv"

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
