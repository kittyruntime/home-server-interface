package main

import (
	"os/exec"
	"regexp"
	"strings"
)

// ── Scheduled TRIM: tell SSDs which blocks are free ─────────────────────────
// fstrim on every mounted filesystem that supports it, and zpool trim on every
// ZFS pool (a pool without trim-capable devices is skipped).

var trimLookPath = exec.LookPath

var reFstrimDone = regexp.MustCompile(`^(.+): (\S+ \S+) \([0-9]+ bytes\) trimmed`)
var reFstrimFail = regexp.MustCompile(`^fstrim: (.+?): (.+)$`)

// parseFstrim reads `fstrim --all --verbose`: one result per filesystem.
func parseFstrim(out string) []taskResult {
	res := []taskResult{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if m := reFstrimDone.FindStringSubmatch(line); m != nil {
			res = append(res, taskResult{Device: m[1], Status: "passed", Message: m[2] + " trimmed"})
			continue
		}
		if m := reFstrimFail.FindStringSubmatch(line); m != nil {
			status := "error"
			if strings.Contains(m[2], "not supported") {
				status = "skipped"
			}
			res = append(res, taskResult{Device: m[1], Status: status, Message: m[2]})
		}
	}
	return res
}

func runTrim() []taskResult {
	results := []taskResult{}
	if _, err := trimLookPath("fstrim"); err == nil {
		// fstrim exits non-zero when one filesystem fails: its lines say which.
		out, err := runArgv([]string{"fstrim", "--all", "--verbose"})
		parsed := parseFstrim(string(out))
		if len(parsed) == 0 && err != nil {
			parsed = append(parsed, taskResult{Device: "fstrim", Status: "error", Message: cmdErrMessage(out, err)})
		}
		results = append(results, parsed...)
	}
	if zfsAvailable() {
		if out, err := hostOutput("zpool", "list", "-Hp", "-o", "name,guid,size,allocated,free,fragmentation,health"); err == nil {
			for _, p := range parseZpoolList(string(out)) {
				out, err := runArgv([]string{"zpool", "trim", p.Name})
				switch {
				case err == nil:
					results = append(results, taskResult{Device: p.Name, PoolGUID: p.GUID, Status: "started"})
				case strings.Contains(string(out), "support trim"):
					results = append(results, taskResult{Device: p.Name, Status: "skipped", Message: "no disk of the pool supports TRIM"})
				default:
					results = append(results, taskResult{Device: p.Name, Status: "error", Message: cmdErrMessage(out, err)})
				}
			}
		}
	}
	if len(results) == 0 {
		return []taskResult{{Device: "trim", Status: "skipped", Message: "neither fstrim nor ZFS is available"}}
	}
	return results
}
