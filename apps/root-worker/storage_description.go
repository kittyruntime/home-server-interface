package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ── Storage descriptions (#37) ───────────────────────────────────────────────
// Each volume HSI manages (a marked fstab entry) is described in a YAML file
// under /etc/hsi/storage: its disks by serial and by-id path, the array, LVM,
// the filesystem and the mount. The file is written after a plan that touched
// the volume succeeds, so it records the last state an admin approved, and it
// is enough to reassemble and mount the volume by hand without HSI.

type descMount struct {
	Point   string `yaml:"point" json:"point"`
	Options string `yaml:"options" json:"options"`
}

type descFS struct {
	Type  string `yaml:"type" json:"type"`
	UUID  string `yaml:"uuid" json:"uuid"`
	Label string `yaml:"label,omitempty" json:"label,omitempty"`
}

type descLVM struct {
	VG string `yaml:"vg" json:"vg"`
	LV string `yaml:"lv" json:"lv"`
	// Set for a volume group with several physical volumes, each by its by-id
	// path or as md:<array uuid>; the array is then not described.
	PVs []string `yaml:"pvs,omitempty" json:"pvs,omitempty"`
}

type descArray struct {
	Name     string `yaml:"name" json:"name"` // name when described; arrays are matched by UUID
	Level    string `yaml:"level" json:"level"`
	Metadata string `yaml:"metadata" json:"metadata"`
	UUID     string `yaml:"uuid" json:"uuid"`
	Devices  int    `yaml:"devices" json:"devices"` // raid-devices
}

type descDisk struct {
	ByID      string `yaml:"byId" json:"byId"`
	Serial    string `yaml:"serial" json:"serial"`
	WWN       string `yaml:"wwn,omitempty" json:"wwn,omitempty"`
	Size      int64  `yaml:"size" json:"size"`
	Role      string `yaml:"role" json:"role"` // active, spare (array members); data otherwise
	Partition int    `yaml:"partition,omitempty" json:"partition,omitempty"`
}

type storageDescription struct {
	Version    int        `yaml:"version" json:"version"`
	Updated    time.Time  `yaml:"updated" json:"updated"`
	Mount      descMount  `yaml:"mount" json:"mount"`
	Filesystem descFS     `yaml:"filesystem" json:"filesystem"`
	LVM        *descLVM   `yaml:"lvm,omitempty" json:"lvm,omitempty"`
	Array      *descArray `yaml:"array,omitempty" json:"array,omitempty"`
	Disks      []descDisk `yaml:"disks" json:"disks"`
}

const descriptionHeader = "# Written by HSI after each storage change it applies to this volume.\n" +
	"# Reassemble and mount it by hand:\n" +
	"# https://kittyruntime.github.io/home-server-interface/guide/storage-descriptions/\n"

func storageDescriptionsDir() string {
	return envOr("HSI_STORAGE_DESCRIPTIONS", "/etc/hsi/storage")
}

// descriptionName turns a mount point into a file name: "/srv/data" is
// "srv-data".
func descriptionName(mountPoint string) string {
	return strings.ReplaceAll(strings.TrimPrefix(filepath.Clean(mountPoint), "/"), "/", "-")
}

func marshalDescription(d storageDescription) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(descriptionHeader)
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(d); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// loadDescriptions returns the descriptions by mount point, and the file each
// one was read from. Files that cannot be read are left to brokenDescriptions.
func loadDescriptions() (map[string]storageDescription, map[string]string) {
	out, files, _ := readDescriptions()
	return out, files
}

// brokenDescriptions returns the files that cannot be read (a hand edit that
// broke the YAML), with the reason.
func brokenDescriptions() map[string]error {
	_, _, broken := readDescriptions()
	return broken
}

func readDescriptions() (map[string]storageDescription, map[string]string, map[string]error) {
	out := map[string]storageDescription{}
	files := map[string]string{}
	broken := map[string]error{}
	paths, _ := filepath.Glob(filepath.Join(storageDescriptionsDir(), "*.yaml"))
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			broken[p] = err
			continue
		}
		var d storageDescription
		if err := yaml.Unmarshal(raw, &d); err != nil {
			broken[p] = err
			continue
		}
		if d.Mount.Point == "" {
			broken[p] = errors.New("no mount point")
			continue
		}
		out[d.Mount.Point] = d
		files[d.Mount.Point] = p
	}
	return out, files, broken
}

// brokenFileFor returns the unreadable file named after mountPoint, if any:
// it is the one a hand edit broke, so HSI writes over it.
func brokenFileFor(mountPoint string) string {
	path := filepath.Join(storageDescriptionsDir(), descriptionName(mountPoint)+".yaml")
	if _, ok := brokenDescriptions()[path]; ok {
		return path
	}
	return ""
}

// saveDescription writes d to the file of its mount point, or to a free name
// when it has none yet ("-2", "-3"... when another mount point maps to the
// same name).
func saveDescription(d storageDescription) (string, error) {
	dir := storageDescriptionsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	_, files := loadDescriptions()
	path, ok := files[d.Mount.Point]
	if !ok {
		path = brokenFileFor(d.Mount.Point)
		ok = path != ""
	}
	if !ok {
		used := map[string]bool{}
		for _, p := range files {
			used[p] = true
		}
		base := descriptionName(d.Mount.Point)
		path = filepath.Join(dir, base+".yaml")
		for n := 2; used[path] || fileExists(path); n++ {
			path = filepath.Join(dir, fmt.Sprintf("%s-%d.yaml", base, n))
		}
	}
	raw, err := marshalDescription(d)
	if err != nil {
		return "", err
	}
	// A temp file of its own (writers can run at once: a plan, the expansion
	// finisher, the start-up backfill), synced before it replaces the file.
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return "", err
	}
	_, werr := tmp.Write(raw)
	if werr == nil {
		werr = tmp.Sync()
	}
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp.Name(), 0o644)
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), path)
	}
	if werr != nil {
		os.Remove(tmp.Name())
		return "", werr
	}
	return path, nil
}

func removeDescription(mountPoint string) error {
	_, files := loadDescriptions()
	path, ok := files[mountPoint]
	if !ok {
		path = brokenFileFor(mountPoint)
	}
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// describeVolumeFn is describeVolume; tests replace it.
var describeVolumeFn = describeVolume

// describeAndSave describes mp from the server. keepMount keeps the mount
// options already described: only mount plans set them, so a hand edit of
// fstab stays a difference after an array or expand operation.
func describeAndSave(mp string, now time.Time, keepMount bool) error {
	d, fe := describeVolumeFn(mp, now)
	if fe != nil {
		return errors.New(fe.Message)
	}
	if keepMount {
		if old, ok := func() (storageDescription, bool) { all, _ := loadDescriptions(); o, ok := all[mp]; return o, ok }(); ok {
			d.Mount.Options = old.Mount.Options
		}
	}
	_, err := saveDescription(d)
	return err
}

// refreshDescriptions applies a successful plan's description changes and
// returns warnings: a description that cannot be written never fails the plan.
func refreshDescriptions(p *opPlan, now time.Time) []string {
	var warnings []string
	warn := func(mp string, err error) {
		warnings = append(warnings, "Could not update the storage description of "+mp+": "+err.Error())
	}
	for _, mp := range p.Describe {
		if err := describeAndSave(mp, now, false); err != nil {
			warn(mp, err)
		}
	}
	again := append([]string{}, p.Redescribe...)
	if p.DescribeArrayUUID != "" {
		all, _ := loadDescriptions()
		for mp, d := range all {
			if d.Array != nil && d.Array.UUID == p.DescribeArrayUUID && !containsString(again, mp) {
				again = append(again, mp)
			}
		}
		sort.Strings(again)
	}
	for _, mp := range again {
		if containsString(p.Describe, mp) {
			continue
		}
		if err := describeAndSave(mp, now, true); err != nil {
			warn(mp, err)
		}
	}
	for _, mp := range p.Forget {
		if err := removeDescription(mp); err != nil {
			warn(mp, err)
		}
	}
	return warnings
}

// backfillDescriptions describes the mounted HSI-managed volumes that have no
// description yet (volumes created before descriptions existed).
func backfillDescriptions(now time.Time) {
	have, _ := loadDescriptions()
	mounts := hostProcMounts()
	for _, v := range hsiVolumes(readFstab()) {
		if _, ok := have[v.MountPoint]; ok {
			continue
		}
		mounted := false
		for _, l := range strings.Split(mounts, "\n") {
			if f := strings.Fields(l); len(f) >= 2 && f[1] == v.MountPoint {
				mounted = true
			}
		}
		if !mounted {
			continue
		}
		if err := describeAndSave(v.MountPoint, now, false); err != nil {
			logger.Warn("storage description", "mountpoint", v.MountPoint, "error", err.Error())
		}
	}
}

// storageTick runs every minute: expansions waiting for their array, and
// descriptions of volumes mounted since (by systemd at boot, after the worker
// started).
func storageTick(now time.Time) {
	finishExpansions(now)
	backfillDescriptions(now)
}
