package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// ── Plan builder: Samba shares (#36) ─────────────────────────────────────────

var (
	hostSmbdInstalled = smbdInstalled
	// hostWriteFile writes a file atomically (temp file + rename).
	hostWriteFile = func(path, content string) error {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
			return err
		}
		return os.Rename(tmp, path)
	}
	errNotExist = os.ErrNotExist
)

func planSmbSync(raw json.RawMessage) (*opPlan, *fsError) {
	var req struct {
		Shares []shareDef `json:"shares"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	if !hostSmbdInstalled() {
		return nil, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"}
	}
	conf, err := renderSmbConf(req.Shares)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	b, readErr := hostReadFile(smbConfPath)
	current, confExists := string(b), readErr == nil
	dropIn := hostExists(dropInPath)
	obs := map[string]string{"smb.conf": current, "dropIn": strconv.FormatBool(dropIn)}

	var steps []planStep
	if !dropIn {
		steps = append(steps, planStep{Kind: "create", Target: dropInPath,
			Summary: "Install the systemd drop-in that points smbd at HSI's smb.conf (the samba package's own file stays untouched)",
			Diff:    unifiedDiff(dropInPath, "", dropInContent),
			run:     func() (string, error) { return "", hostWriteFile(dropInPath, dropInContent) }})
	}
	if !confExists || current != conf {
		kind, summary := "update", "Update the Samba configuration"
		if !confExists {
			kind, summary = "create", "Create the Samba configuration"
		}
		steps = append(steps, planStep{Kind: kind, Target: smbConfPath, Summary: summary,
			Diff: unifiedDiff(smbConfPath, current, conf),
			run:  func() (string, error) { return "", hostWriteFile(smbConfPath, conf) }})
	}
	enable := cmdStep("smbd", "Enable smbd at boot", []string{"systemctl", "enable", "--quiet", "smbd"})
	enable.OnFailure = "warn"
	if !dropIn {
		steps = append(steps,
			cmdStep("systemd", "Reload systemd so it sees the drop-in", []string{"systemctl", "daemon-reload"}),
			enable,
			cmdStep("smbd", "Restart smbd with HSI's configuration; open SMB sessions are dropped", []string{"systemctl", "restart", "smbd"}))
	} else {
		steps = append(steps, enable,
			cmdStep("smbd", "Reload smbd so clients see the new shares (restarts it if it is stopped)", []string{"systemctl", "reload-or-restart", "smbd"}))
	}
	return &opPlan{Op: "smb.sync", Steps: steps, Observed: obs}, nil
}
