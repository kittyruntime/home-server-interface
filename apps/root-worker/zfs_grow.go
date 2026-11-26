package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ── Growing a pool: add a vdev, use bigger disks, widen a raidz or a mirror ──

var reExpandPct = regexp.MustCompile(`([0-9.]+)% done`)
var reExpandVdev = regexp.MustCompile(`(?:expansion of|expanded) (\S+)`)

// parseExpand reads the "expand:" lines of zpool status.
func parseExpand(lines []string) zfsExpand {
	text := strings.Join(lines, " ")
	e := zfsExpand{State: "none"}
	if m := reExpandVdev.FindStringSubmatch(text); m != nil {
		e.Vdev = m[1]
	}
	switch {
	case strings.Contains(text, "in progress"):
		e.State = "running"
		if m := reExpandPct.FindStringSubmatch(text); m != nil {
			e.Pct, _ = strconv.ParseFloat(m[1], 64)
		}
	case strings.HasPrefix(strings.TrimSpace(text), "expanded"):
		e.State = "finished"
	}
	return e
}

// parseExpandSizes reads `zpool list -Hp -o name,expandsize` ("-" is none).
func parseExpandSizes(out string) map[string]int64 {
	res := map[string]int64{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) != 2 {
			continue
		}
		if n, err := strconv.ParseInt(f[1], 10, 64); err == nil {
			res[f[0]] = n
		}
	}
	return res
}

// dataVdevs: the top-level vdevs that hold data (not logs, cache, spares,
// special or dedup).
func dataVdevs(vs []zfsVdev) []zfsVdev {
	res := []zfsVdev{}
	for _, v := range vs {
		switch v.Type {
		case "log", "cache", "spare", "special", "dedup", "logs", "spares":
			continue
		}
		res = append(res, v)
	}
	return res
}

// poolDataLayout: the one layout the pool's data vdevs share (stripe, mirror,
// raidz1-3) and their width. A pool mixing layouts, or on dRAID, has none.
func poolDataLayout(vs []zfsVdev) (layout string, width int, ok bool) {
	for i, v := range dataVdevs(vs) {
		l, w := v.Type, len(v.Children)
		if len(v.Children) == 0 {
			l, w = "stripe", 1
		}
		if l != "stripe" && l != "mirror" && l != "raidz1" && l != "raidz2" && l != "raidz3" {
			return "", 0, false
		}
		if i == 0 {
			layout, width = l, w
		} else if l != layout || (l != "stripe" && w != width) {
			return "", 0, false
		}
	}
	return layout, width, layout != ""
}

// freeWholeDisk checks a disk a pool can take and gives its stable path.
func freeWholeDisk(d string, sys map[string]bool, ids map[string]string) (string, *fsError) {
	if !reBlockDev.MatchString(d) {
		return "", &fsError{Code: "ERR", Message: "invalid device name: " + d}
	}
	if sys[d] {
		return "", &fsError{Code: "ESYS", Message: "device " + d + " belongs to the system disk"}
	}
	if !hostWholeDisk(d) {
		return "", &fsError{Code: "ERR", Message: d + " is not a whole disk"}
	}
	if fe := hostClaimable(d); fe != nil {
		return "", fe
	}
	if id := ids[d]; id != "" {
		return "/dev/disk/by-id/" + id, nil
	}
	return "/dev/" + d, nil
}

func planZfsPoolAdd(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Pool  string   `json:"pool"`
		Disks []string `json:"disks"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	pool, fe := importedPool(req.Pool)
	if fe != nil {
		return nil, fe
	}
	layout, width, ok := poolDataLayout(pool.Vdevs)
	if !ok {
		return nil, &fsError{Code: "ERR", Message: req.Pool + " mixes layouts or uses dRAID: add to it from the command line"}
	}
	if (layout == "stripe" && len(req.Disks) < 1) || (layout != "stripe" && len(req.Disks) != width) {
		return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("%s is made of %s groups of %d disks: add %d disks", req.Pool, layout, width, width)}
	}
	sys, ids := hostSystemDevs(), preferredByID(hostByIDLinks())
	obs := map[string]string{"pool": pool.GUID}
	seen := map[string]bool{}
	var devs, vdev []string
	for _, d := range req.Disks {
		if seen[d] {
			return nil, &fsError{Code: "ERR", Message: d + " is listed twice"}
		}
		seen[d] = true
		p, fe := freeWholeDisk(d, sys, ids)
		if fe != nil {
			return nil, fe
		}
		devs = append(devs, "/dev/"+d)
		vdev = append(vdev, p)
		observeDevice(obs, "/dev/"+d, "/dev/"+d)
	}
	argv := []string{"zpool", "add", req.Pool}
	if layout != "stripe" {
		argv = append(argv, layout)
	}
	argv = append(argv, vdev...)
	what := "a " + layout + " group of " + strings.Join(devs, ", ")
	if layout == "stripe" {
		what = strings.Join(devs, ", ") + " (no redundancy, like the rest of the pool)"
	}
	s := destructiveAll(cmdStep(req.Pool, "Add "+what+" to "+req.Pool+", erasing them. This cannot be removed from the pool afterwards", argv), devs)
	return &opPlan{Op: "zfs.pool.add", Steps: []planStep{s}, Observed: obs}, nil
}

func planZfsPoolExpand(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Pool string `json:"pool"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	pool, fe := importedPool(req.Pool)
	if fe != nil {
		return nil, fe
	}
	if pool.ExpandSize <= 0 {
		return nil, &fsError{Code: "ERR", Message: req.Pool + " already uses all the space of its disks"}
	}
	steps := []planStep{cmdStep(req.Pool, "Let "+req.Pool+" grow by itself when its disks get bigger", []string{"zpool", "set", "autoexpand=on", req.Pool})}
	for _, v := range dataVdevs(pool.Vdevs) {
		for _, l := range leavesOf(v) {
			if len(l.Children) == 0 && strings.HasPrefix(l.Name, "/dev/") {
				steps = append(steps, cmdStep(l.Name, "Use the whole of "+l.Name, []string{"zpool", "online", "-e", req.Pool, l.Name}))
			}
		}
	}
	return &opPlan{Op: "zfs.pool.expand", Steps: steps, Observed: map[string]string{"pool": pool.GUID, "expandSize": strconv.FormatInt(pool.ExpandSize, 10)}}, nil
}

// versionAtLeast compares dotted versions: 2.3.1 is at least 2.3.
func versionAtLeast(v string, major, minor int) bool {
	p := strings.Split(v, ".")
	if len(p) < 2 {
		return false
	}
	a, _ := strconv.Atoi(p[0])
	b, _ := strconv.Atoi(p[1])
	return a > major || (a == major && b >= minor)
}

func planZfsPoolAttach(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Pool string `json:"pool"`
		Vdev string `json:"vdev"`
		Disk string `json:"disk"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	pool, fe := importedPool(req.Pool)
	if fe != nil {
		return nil, fe
	}
	var target *zfsVdev
	for _, v := range dataVdevs(pool.Vdevs) {
		if v.Name == req.Vdev && len(v.Children) > 0 {
			t := v
			target = &t
		}
	}
	if target == nil {
		return nil, &fsError{Code: "ERR", Message: req.Vdev + " is not a mirror or raidz group of " + req.Pool}
	}
	sys, ids := hostSystemDevs(), preferredByID(hostByIDLinks())
	p, fe := freeWholeDisk(req.Disk, sys, ids)
	if fe != nil {
		return nil, fe
	}
	dev := "/dev/" + req.Disk
	var argv []string
	var summary string
	switch {
	case target.Type == "mirror":
		argv = []string{"zpool", "attach", req.Pool, target.Children[0].Name, p}
		summary = "Add " + dev + " to " + req.Vdev + " of " + req.Pool + " as one more copy, erasing it; ZFS copies the data onto it (resilver)"
	case strings.HasPrefix(target.Type, "raidz"):
		if v := zfsSnapshot().Version; !versionAtLeast(v, 2, 3) {
			return nil, &fsError{Code: "ENOTOOL", Message: "widening a raidz group needs OpenZFS 2.3 or later (this server has " + v + ")"}
		}
		argv = []string{"zpool", "attach", req.Pool, req.Vdev, p}
		summary = "Widen " + req.Vdev + " of " + req.Pool + " with " + dev + ", erasing it; ZFS spreads the data over the new disk (hours on large pools), and the pool stays usable"
	default:
		return nil, &fsError{Code: "ERR", Message: req.Vdev + " cannot take another disk"}
	}
	obs := map[string]string{"pool": pool.GUID}
	observeDevice(obs, dev, dev)
	s := destructiveAll(cmdStep(req.Pool, summary, argv), []string{dev})
	return &opPlan{Op: "zfs.pool.attach", Steps: []planStep{s}, Observed: obs}, nil
}
