package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	nats "github.com/nats-io/nats.go"
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
		// Only UUID= sources identify the filesystem; a device path could be
		// another disk after a reboot.
		if len(f) < 4 || f[1] != mp || !strings.HasPrefix(f[0], "UUID=") {
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
	return volumeStateFor(expectedUUID, "", findmntOut)
}

// volumeStateFor also takes the fstab options: a volume mounted read-only on
// purpose is ok; only one that became read-only (e.g. errors=remount-ro) is
// reported.
func volumeStateFor(expectedUUID, fstabOpts, findmntOut string) string {
	mounted, uuid, ro := parseFindmnt(findmntOut)
	wantRO := false
	for _, o := range strings.Split(fstabOpts, ",") {
		if o == "ro" {
			wantRO = true
		}
	}
	switch {
	case !mounted:
		return "missing"
	case uuid != expectedUUID:
		return "wrong"
	case ro && !wantRO:
		return "readonly"
	default:
		return "ok"
	}
}

// missingVolumeAction decides what to do with a volume that is not mounted:
// remount it only when its disk was seen absent and is present again (it came
// back). A disk that is present but was never seen absent was unmounted on
// purpose, or is not mounted yet: leave it alone.
func missingVolumeAction(devicePresent, seenAbsent bool) (state string, remount, seenAbsentNext bool) {
	switch {
	case !devicePresent:
		return "missing", false, true
	case seenAbsent:
		return "missing", true, false
	default:
		return "unmounted", false, false
	}
}

// ── Host side ────────────────────────────────────────────────────────────────

var (
	volumeGuardMu sync.Mutex
	volumeStray   = map[string]bool{}   // mount point -> files found on the boot disk under it
	volumeGuardEr = map[string]string{} // mount point -> last chattr error
)

// Mount points whose disk was seen absent, kept in /run (cleared at boot) so
// the worker service and the `hsi-worker volumes` command share it.
const volumeAbsentFile = "/run/hsi-worker/volumes-absent.json"

func loadVolumeAbsent() map[string]bool {
	m := map[string]bool{}
	if b, err := os.ReadFile(volumeAbsentFile); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func saveVolumeAbsent(m map[string]bool) {
	if err := os.MkdirAll(filepath.Dir(volumeAbsentFile), 0700); err != nil {
		return
	}
	b, _ := json.Marshal(m)
	_ = os.WriteFile(volumeAbsentFile, b, 0600)
}

func dirHasEntries(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

func isMounted(mp string) bool {
	out, _ := command("findmnt", "-n", "-o", "TARGET", "--mountpoint", mp).Output()
	return strings.TrimSpace(string(out)) != ""
}

// protectMountPoint makes the directory under a mount point immutable, so
// nothing can write to the boot disk when the volume is absent. For a mounted
// volume the hidden directory is reached through a private, non-recursive bind
// of the parent filesystem (submounts, including this volume, are not carried
// over). Reports whether files already sit in that directory.
func protectMountPoint(mp string) (bool, error) {
	// Work on the real path: a symlink in a parent component must not lead
	// the chattr anywhere else.
	if real, err := filepath.EvalSymlinks(mp); err == nil {
		mp = real
	}
	if !isMounted(mp) {
		if err := os.MkdirAll(mp, 0755); err != nil {
			return false, err
		}
		stray := dirHasEntries(mp)
		return stray, command("chattr", "+i", mp).Run()
	}
	parentOut, err := command("findmnt", "-n", "-o", "TARGET", "-T", filepath.Dir(mp)).Output()
	if err != nil {
		return false, err
	}
	parent := strings.TrimSpace(string(parentOut))
	rel := strings.TrimPrefix(mp, strings.TrimSuffix(parent, "/"))
	tmp, err := os.MkdirTemp("/run", "hsi-under-")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp)
	// In a private mount namespace: the bind never reaches the host (no
	// propagation, nothing to clean up if we die), and it disappears when the
	// shell exits. The device check refuses to touch anything that is not on
	// the parent filesystem (e.g. a symlink escaping into the mounted volume).
	script := `set -e
mount --bind "$1" "$2"
d="$2$3"
[ "$(stat -c %d "$d")" = "$(stat -c %d "$2")" ] || { echo "mount point is not on its parent filesystem" >&2; exit 3; }
if [ -n "$(ls -A "$d")" ]; then echo stray; fi
chattr +i "$d"`
	out, err := command("unshare", "--mount", "--propagation", "private", "--", "sh", "-c", script, "_", parent, tmp, rel).CombinedOutput()
	stray := strings.Contains(string(out), "stray")
	if err != nil {
		return stray, fmt.Errorf("%s", strings.TrimSpace(strings.ReplaceAll(string(out), "stray", "")))
	}
	return stray, nil
}

func unprotectMountPoint(mp string) {
	if err := command("chattr", "-i", mp).Run(); err != nil {
		logger.Warn("volume guard: could not clear immutable flag", "mountPoint", mp, "error", err.Error())
	}
}

func recordGuard(mp string, stray bool, err error) {
	volumeGuardMu.Lock()
	defer volumeGuardMu.Unlock()
	volumeStray[mp] = stray
	if err != nil {
		volumeGuardEr[mp] = err.Error()
		logger.Warn("volume guard: could not protect mount point", "mountPoint", mp, "error", err.Error())
	} else {
		delete(volumeGuardEr, mp)
	}
}

// prepareVolumes runs once at worker start: boot options on marked fstab
// entries, then an immutable mount point for every HSI volume.
func prepareVolumes() {
	if err := editFstab(func(conf string) (string, error) { return ensureBootOptions(conf), nil }); err != nil {
		logger.Warn("volume guard: could not update fstab boot options", "error", err.Error())
	}
	conf, err := os.ReadFile(fstabPath)
	if err != nil {
		return
	}
	for _, v := range hsiVolumes(string(conf)) {
		stray, err := protectMountPoint(v.MountPoint)
		recordGuard(v.MountPoint, stray, err)
	}
}

type volumeStatus struct {
	MountPoint string `json:"mountPoint"`
	UUID       string `json:"uuid"`
	State      string `json:"state"`
	StrayFiles bool   `json:"strayFiles"`
	GuardError string `json:"guardError,omitempty"`
}

// volumeStatuses reports every HSI volume, remounting one whose filesystem is
// present again (same UUID, so it is the right one) through its fstab entry.
func volumeStatuses() ([]volumeStatus, error) {
	conf, err := os.ReadFile(fstabPath)
	if err != nil {
		return nil, err
	}
	out := []volumeStatus{}
	volumeGuardMu.Lock()
	absent := loadVolumeAbsent()
	volumeGuardMu.Unlock()
	defer func() {
		volumeGuardMu.Lock()
		saveVolumeAbsent(absent)
		volumeGuardMu.Unlock()
	}()
	for _, v := range hsiVolumes(string(conf)) {
		findmnt := func() string {
			o, _ := command("findmnt", "-n", "-P", "-o", "UUID,OPTIONS", "--mountpoint", v.MountPoint).Output()
			return string(o)
		}
		state := volumeStateFor(v.UUID, v.Options, findmnt())
		if state == "missing" {
			dev, err := command("blkid", "-U", v.UUID).Output()
			present := err == nil && strings.TrimSpace(string(dev)) != ""
			next, remount, seenNext := missingVolumeAction(present, absent[v.MountPoint])
			state = next
			if remount {
				if err := command("mount", v.MountPoint).Run(); err == nil {
					logger.Info("volume guard: remounted returning volume", "mountPoint", v.MountPoint)
					state = volumeStateFor(v.UUID, v.Options, findmnt())
				} else {
					seenNext = true // try again on the next check
				}
			}
			absent[v.MountPoint] = seenNext
		} else {
			delete(absent, v.MountPoint)
		}
		volumeGuardMu.Lock()
		out = append(out, volumeStatus{MountPoint: v.MountPoint, UUID: v.UUID, State: state, StrayFiles: volumeStray[v.MountPoint], GuardError: volumeGuardEr[v.MountPoint]})
		volumeGuardMu.Unlock()
	}
	return out, nil
}

func handleVolumes(nc *nats.Conn, msg *nats.Msg) {
	vols, err := volumeStatuses()
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "read fstab: " + err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"volumes": vols})
}
