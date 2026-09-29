package main

import (
	"path/filepath"
	"strings"
)

// ── Volumes ──────────────────────────────────────────────────────────────────
// HSI's marked fstab entries are the registry of data volumes it watches
// (#3): each must be mounted, from the right filesystem, read-write, before
// anything writes under its mount point.

type volumeEntry struct {
	MountPoint string `json:"mountPoint"`
	Source     string `json:"source"`
	UUID       string `json:"uuid"`
	FSType     string `json:"fstype"`
	Options    string `json:"options"`
}

func hsiVolumes(conf string) []volumeEntry {
	lines := splitConf(conf)
	var out []volumeEntry
	for i := 0; i+1 < len(lines); i++ {
		if !strings.HasPrefix(lines[i], hsiMountMarker) {
			continue
		}
		mp := strings.TrimPrefix(lines[i], hsiMountMarker)
		f := strings.Fields(lines[i+1])
		if len(f) < 4 || f[1] != mp {
			continue
		}
		out = append(out, volumeEntry{MountPoint: mp, Source: f[0], UUID: strings.TrimPrefix(f[0], "UUID="), FSType: f[2], Options: f[3]})
	}
	return out
}

// withBootOptions lets the boot go on without the volume: an absent data disk
// must never send the NAS to emergency mode.
func withBootOptions(opts string) string {
	parts := strings.Split(opts, ",")
	has := func(name string) bool {
		for _, p := range parts {
			if p == name || strings.HasPrefix(p, name+"=") {
				return true
			}
		}
		return false
	}
	if !has("nofail") {
		opts += ",nofail"
	}
	if !has("x-systemd.device-timeout") {
		opts += ",x-systemd.device-timeout=10s"
	}
	return opts
}

// ensureBootOptions adds the boot options to HSI's marked entries only.
func ensureBootOptions(conf string) string {
	lines := splitConf(conf)
	for i := 0; i+1 < len(lines); i++ {
		if !strings.HasPrefix(lines[i], hsiMountMarker) {
			continue
		}
		f := strings.Fields(lines[i+1])
		if len(f) < 4 || f[1] != strings.TrimPrefix(lines[i], hsiMountMarker) {
			continue
		}
		if opts := withBootOptions(f[3]); opts != f[3] {
			f[3] = opts
			lines[i+1] = strings.Join(f, "\t")
		}
	}
	return joinConf(lines)
}

// volumeOwner returns the volume a path lives on: the longest mount point
// that is a path prefix (/mnt/data does not own /mnt/data2).
func volumeOwner(vols []volumeEntry, path string) (volumeEntry, bool) {
	path = filepath.Clean(path)
	var best volumeEntry
	found := false
	for _, v := range vols {
		if path == v.MountPoint || strings.HasPrefix(path, v.MountPoint+"/") {
			if !found || len(v.MountPoint) > len(best.MountPoint) {
				best, found = v, true
			}
		}
	}
	return best, found
}

// parseFindmnt reads `findmnt -n -P -o UUID,OPTIONS --mountpoint <mp>`.
func parseFindmnt(out string) (mounted bool, uuid string, readOnly bool) {
	line := strings.TrimSpace(out)
	if line == "" {
		return false, "", false
	}
	fields := map[string]string{}
	for _, kv := range strings.Fields(line) {
		if k, v, ok := strings.Cut(kv, "="); ok {
			fields[k] = strings.Trim(v, `"`)
		}
	}
	opts := strings.Split(fields["OPTIONS"], ",")
	return true, fields["UUID"], opts[0] == "ro"
}

func volumeState(expectedUUID, findmntOut string) string {
	mounted, uuid, ro := parseFindmnt(findmntOut)
	switch {
	case !mounted:
		return "missing"
	case uuid != expectedUUID:
		return "wrong"
	case ro:
		return "readonly"
	default:
		return "ok"
	}
}
