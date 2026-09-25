package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// cmdErrMessage turns a failed external command into a user-facing message:
// the command's own output when it printed something, otherwise the error
// itself (e.g. "executable file not found") — never an empty string.
func cmdErrMessage(out []byte, err error) string {
	if msg := strings.TrimSpace(string(out)); msg != "" {
		return msg
	}
	if err != nil {
		return err.Error()
	}
	return "command failed without output"
}

// ── /etc/mdadm/mdadm.conf ─────────────────────────────────────────────────────
// The file belongs to the mdadm package and may hold the admin's MAILADDR,
// DEVICE, HOMEHOST and ARRAY lines. HSI only adds, replaces or removes the
// ARRAY line of arrays it manages, each preceded by a marker comment.

const mdadmConfPath = "/etc/mdadm/mdadm.conf"

const hsiArrayMarker = "# HSI-managed array: "

// arrayLineFields returns the device and UUID of an "ARRAY <dev> ... UUID=<uuid>" line.
func arrayLineFields(line string) (device, uuid string) {
	f := strings.Fields(line)
	if len(f) < 2 || f[0] != "ARRAY" {
		return "", ""
	}
	for _, kv := range f[2:] {
		if strings.HasPrefix(kv, "UUID=") {
			uuid = strings.TrimPrefix(kv, "UUID=")
		}
	}
	return f[1], uuid
}

// splitConf splits the file into lines, without the trailing empty element.
func splitConf(conf string) []string {
	if conf == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(conf, "\n"), "\n")
}

func joinConf(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// withoutHSIEntry drops the marker and ARRAY line HSI wrote for name, plus any
// unmarked ARRAY line for the same device or UUID (files overwritten by earlier
// HSI versions have no marker).
func withoutHSIEntry(lines []string, name, uuid string) []string {
	dev := "/dev/" + name
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		if lines[i] == hsiArrayMarker+name {
			if i+1 < len(lines) && strings.HasPrefix(lines[i+1], "ARRAY ") {
				i++
			}
			continue
		}
		if d, u := arrayLineFields(lines[i]); d != "" && (d == dev || (uuid != "" && u == uuid)) {
			continue
		}
		out = append(out, lines[i])
	}
	return out
}

// upsertArrayLine adds or replaces the HSI-managed ARRAY line of array name
// (e.g. "md0") and leaves every other line of conf untouched.
func upsertArrayLine(conf, name, arrayLine string) string {
	_, uuid := arrayLineFields(arrayLine)
	lines := withoutHSIEntry(splitConf(conf), name, uuid)
	lines = append(lines, hsiArrayMarker+name, arrayLine)
	return joinConf(lines)
}

// removeArrayLine removes the HSI-managed entry of array name only; ARRAY
// lines the admin wrote without HSI's marker are kept.
func removeArrayLine(conf, name string) string {
	lines := splitConf(conf)
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		if lines[i] == hsiArrayMarker+name {
			if i+1 < len(lines) && strings.HasPrefix(lines[i+1], "ARRAY ") {
				i++
			}
			continue
		}
		out = append(out, lines[i])
	}
	return joinConf(out)
}

// briefArrayLine extracts the ARRAY line from `mdadm --detail --brief` output.
func briefArrayLine(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "ARRAY ") {
			return strings.TrimSpace(line)
		}
	}
	return ""
}

// writeFileAtomic replaces path through a temp file in the same directory,
// keeping the existing file's mode when there is one.
func writeFileAtomic(path string, data []byte, defaultPerm os.FileMode) error {
	perm := defaultPerm
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".hsi-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// updateMdadmConf applies edit to mdadm.conf and refreshes the initramfs so
// the array keeps its name at boot (otherwise it may come back as md127).
// Returns warnings for the caller to report; the array itself already exists.
func updateMdadmConf(edit func(string) string) []string {
	var warnings []string
	current, err := os.ReadFile(mdadmConfPath)
	if err != nil && !os.IsNotExist(err) {
		return []string{fmt.Sprintf("could not read %s: %v", mdadmConfPath, err)}
	}
	next := edit(string(current))
	if next == string(current) {
		return nil
	}
	if err := writeFileAtomic(mdadmConfPath, []byte(next), 0644); err != nil {
		return []string{fmt.Sprintf("could not update %s: %v", mdadmConfPath, err)}
	}
	if _, err := exec.LookPath("update-initramfs"); err == nil {
		if out, err := exec.Command("update-initramfs", "-u").CombinedOutput(); err != nil {
			warnings = append(warnings, "update-initramfs failed: "+cmdErrMessage(out, err))
		}
	}
	return warnings
}
