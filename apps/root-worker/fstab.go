package main

import (
	"fmt"
	"os"
	"strings"
	"sync"
)

// ── /etc/fstab ────────────────────────────────────────────────────────────────
// /etc/fstab belongs to the system and the admin. HSI only adds, replaces or
// removes the entries of mounts it made, each preceded by a marker comment
// (fstab has no trailing comments). Entries written by earlier HSI versions
// carry no marker; they are recognised by mount point AND source.

const fstabPath = "/etc/fstab"

const hsiMountMarker = "# HSI-managed mount: "

// fstabMu serialises read-modify-write cycles of /etc/fstab.
var fstabMu sync.Mutex

func fstabFields(line string) (source, mountPoint string) {
	if strings.HasPrefix(strings.TrimSpace(line), "#") {
		return "", ""
	}
	f := strings.Fields(line)
	if len(f) < 2 {
		return "", ""
	}
	return f[0], f[1]
}

// dropMarkedEntry removes HSI's marker + entry for mountPoint.
func dropMarkedEntry(lines []string, mountPoint string) []string {
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		if lines[i] == hsiMountMarker+mountPoint {
			if i+1 < len(lines) {
				if _, mp := fstabFields(lines[i+1]); mp == mountPoint {
					i++
				}
			}
			continue
		}
		out = append(out, lines[i])
	}
	return out
}

// upsertFstabEntry adds or replaces HSI's entry for mountPoint. An unmarked
// entry for the same mount point is adopted when it has the same source
// (written by an earlier HSI version); otherwise it belongs to the admin and
// the request is refused rather than silently overridden or duplicated.
func upsertFstabEntry(conf, mountPoint, source, entry string) (string, error) {
	lines := dropMarkedEntry(splitConf(conf), mountPoint)
	out := make([]string, 0, len(lines)+2)
	for _, l := range lines {
		if src, mp := fstabFields(l); mp == mountPoint {
			if src != source {
				return "", fmt.Errorf("%s already has an entry for %s (%s) that HSI did not write — edit it by hand or choose another mount point", fstabPath, mountPoint, src)
			}
			continue // legacy HSI entry, replaced below
		}
		out = append(out, l)
	}
	out = append(out, hsiMountMarker+mountPoint, entry)
	return joinConf(out), nil
}

// removeFstabLines removes HSI's entry for mountPoint, plus unmarked entries
// for that mount point whose source is the device that was mounted there
// (legacy HSI entries). Admin entries with another source are kept.
func removeFstabLines(conf, mountPoint string, sources ...string) string {
	lines := dropMarkedEntry(splitConf(conf), mountPoint)
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if src, mp := fstabFields(l); mp == mountPoint && src != "" && containsString(sources, src) {
			continue
		}
		out = append(out, l)
	}
	return joinConf(out)
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// editFstab applies edit to /etc/fstab atomically, keeping its mode. A
// missing file is an error: HSI never creates the system's fstab.
func editFstab(edit func(string) (string, error)) error {
	fstabMu.Lock()
	defer fstabMu.Unlock()
	current, err := os.ReadFile(fstabPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", fstabPath, err)
	}
	next, err := edit(string(current))
	if err != nil {
		return err
	}
	if next == string(current) {
		return nil
	}
	if err := writeFileAtomic(fstabPath, []byte(next), 0644); err != nil {
		return fmt.Errorf("write %s: %w", fstabPath, err)
	}
	return nil
}
