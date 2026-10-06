package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
