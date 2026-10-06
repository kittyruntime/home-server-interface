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
	Point   string `yaml:"point"`
	Options string `yaml:"options"`
}

type descFS struct {
	Type  string `yaml:"type"`
	UUID  string `yaml:"uuid"`
	Label string `yaml:"label,omitempty"`
}

type descLVM struct {
	VG string `yaml:"vg"`
	LV string `yaml:"lv"`
	// Set for a volume group with several physical volumes, each by its by-id
	// path or as md:<array uuid>; the array is then not described.
	PVs []string `yaml:"pvs,omitempty"`
}

type descArray struct {
	Name     string `yaml:"name"` // name when described; arrays are matched by UUID
	Level    string `yaml:"level"`
	Metadata string `yaml:"metadata"`
	UUID     string `yaml:"uuid"`
	Devices  int    `yaml:"devices"` // raid-devices
}

type descDisk struct {
	ByID      string `yaml:"byId"`
	Serial    string `yaml:"serial"`
	WWN       string `yaml:"wwn,omitempty"`
	Size      int64  `yaml:"size"`
	Role      string `yaml:"role"` // active, spare (array members); data otherwise
	Partition int    `yaml:"partition,omitempty"`
}

type storageDescription struct {
	Version    int        `yaml:"version"`
	Updated    time.Time  `yaml:"updated"`
	Mount      descMount  `yaml:"mount"`
	Filesystem descFS     `yaml:"filesystem"`
	LVM        *descLVM   `yaml:"lvm,omitempty"`
	Array      *descArray `yaml:"array,omitempty"`
	Disks      []descDisk `yaml:"disks"`
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
// one was read from. Unreadable files are skipped.
func loadDescriptions() (map[string]storageDescription, map[string]string) {
	out := map[string]storageDescription{}
	files := map[string]string{}
	paths, _ := filepath.Glob(filepath.Join(storageDescriptionsDir(), "*.yaml"))
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var d storageDescription
		if err := yaml.Unmarshal(raw, &d); err != nil || d.Mount.Point == "" {
			logger.Warn("unreadable storage description", "file", p, "error", fmt.Sprint(err))
			continue
		}
		out[d.Mount.Point] = d
		files[d.Mount.Point] = p
	}
	return out, files
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
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return path, nil
}

func removeDescription(mountPoint string) error {
	_, files := loadDescriptions()
	path, ok := files[mountPoint]
	if !ok {
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

func describeAndSave(mp string, now time.Time) error {
	d, fe := describeVolumeFn(mp, now)
	if fe != nil {
		return errors.New(fe.Message)
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
	targets := append([]string{}, p.Describe...)
	if p.DescribeArrayUUID != "" {
		all, _ := loadDescriptions()
		for mp, d := range all {
			if d.Array != nil && d.Array.UUID == p.DescribeArrayUUID && !containsString(targets, mp) {
				targets = append(targets, mp)
			}
		}
		sort.Strings(targets)
	}
	for _, mp := range targets {
		if err := describeAndSave(mp, now); err != nil {
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
		if err := describeAndSave(v.MountPoint, now); err != nil {
			logger.Warn("storage description", "mountpoint", v.MountPoint, "error", err.Error())
		}
	}
}
