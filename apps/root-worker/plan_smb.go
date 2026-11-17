package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// ── Plan builder: Samba shares (#36) ─────────────────────────────────────────

var (
	hostSmbdInstalled = smbdInstalled
	hostWriteFile     = writeSmbFile
	errNotExist       = os.ErrNotExist
	hostMkdirPrivate  = func(path string) error { return os.MkdirAll(path, 0o750) }
	hostNfsIDsFn      = hostNfsIDs
	hostRemoveFile    = func(path string) error {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
)

// smbMu serializes every write of the Samba configuration: automatic syncs
// (root.sharing.sync) and applied plans run on separate subscriptions.
var smbMu sync.Mutex

// writeSmbFile writes through a unique temp file, so concurrent writers never
// share one.
func writeSmbFile(path, content string) error {
	return writeFileAtomic(path, []byte(content), 0o644)
}

// shareSyncReq is the whole desired sharing state. Nfs is absent from callers
// that only know SMB; then NFS is left as it is.
type shareSyncReq struct {
	Shares   []shareDef  `json:"shares"`
	Settings smbSettings `json:"settings"`
	Nfs      *struct {
		Exports []nfsExportDef `json:"exports"`
	} `json:"nfs"`
	Sftp *struct {
		Users []sftpUserDef `json:"users"`
	} `json:"sftp"`
}

func planSmbSync(raw json.RawMessage) (*opPlan, *fsError) {
	var req shareSyncReq
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, badRequest(err)
	}
	obs := map[string]string{}
	var steps []planStep
	// Samba is needed for SMB shares, and by callers that only know SMB.
	if hostSmbdInstalled() || (req.Nfs == nil && req.Sftp == nil) || len(req.Shares) > 0 {
		s, fe := smbSyncSteps(req, obs)
		if fe != nil {
			return nil, fe
		}
		steps = append(steps, s...)
	}
	if req.Nfs != nil {
		s, fe := nfsSyncSteps(req.Nfs.Exports, obs)
		if fe != nil {
			return nil, fe
		}
		steps = append(steps, s...)
	}
	if req.Sftp != nil {
		s, fe := sftpSyncSteps(req.Sftp.Users, obs)
		if fe != nil {
			return nil, fe
		}
		steps = append(steps, s...)
	}
	return &opPlan{Op: "smb.sync", Steps: steps, Observed: obs}, nil
}

// nfsSyncSteps writes HSI's exports file and has the kernel server re-read
// it. The service is started for a first export but never stopped: the
// owner may export other folders.
func nfsSyncSteps(exports []nfsExportDef, obs map[string]string) ([]planStep, *fsError) {
	b, readErr := hostReadFile(nfsExportsPath)
	current, exists := string(b), readErr == nil
	obs["exports"] = current
	want := ""
	if len(exports) > 0 {
		if !hostLookPath("exportfs") {
			return nil, &fsError{Code: "NFS_MISSING", Message: "the NFS server is not installed"}
		}
		// exportfs follows links: a folder someone other than root could swap
		// for a link to elsewhere is left out, like a missing volume.
		checked := make([]nfsExportDef, len(exports))
		for i, e := range exports {
			if err := hostSafeFolder(e.Path); err != nil {
				log.Printf("nfs: %s not exported: %v", e.Path, err)
				e.Unavailable = true
			}
			checked[i] = e
		}
		exports = checked
		ids, err := hostNfsIDsFn()
		if err != nil {
			return nil, &fsError{Code: "ERR", Message: err.Error()}
		}
		if want, err = renderExports(exports, ids); err != nil {
			return nil, &fsError{Code: "ERR", Message: err.Error()}
		}
	}
	if want == current {
		return nil, nil
	}
	var steps []planStep
	switch {
	case want == "" && exists:
		steps = append(steps, planStep{Kind: "delete", Target: nfsExportsPath, Summary: "Stop exporting HSI's folders over NFS",
			Diff: unifiedDiff(nfsExportsPath, current, ""),
			run:  func() (string, error) { return "", hostRemoveFile(nfsExportsPath) }})
	case want == "":
		return nil, nil
	default:
		kind, summary := "update", "Update the NFS exports"
		if !exists {
			kind, summary = "create", "Create the NFS exports"
		}
		steps = append(steps, planStep{Kind: kind, Target: nfsExportsPath, Summary: summary,
			Diff: unifiedDiff(nfsExportsPath, current, want),
			run:  func() (string, error) { return "", hostWriteFile(nfsExportsPath, want) }})
	}
	if hostLookPath("exportfs") {
		steps = append(steps, cmdStep("exportfs", "Have the NFS server read the exports again", []string{"exportfs", "-ra"}))
	}
	if want != "" {
		start := cmdStep("nfs-server", "Start the NFS server, now and at boot", []string{"systemctl", "enable", "--now", "nfs-server"})
		start.OnFailure = "warn"
		steps = append(steps, start)
	}
	return steps, nil
}

func smbSyncSteps(req shareSyncReq, obs map[string]string) ([]planStep, *fsError) {
	if !hostSmbdInstalled() {
		return nil, &fsError{Code: "SMBD_MISSING", Message: "samba is not installed"}
	}
	conf, err := renderSmbConf(req.Shares, req.Settings)
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	b, readErr := hostReadFile(smbConfPath)
	current, confExists := string(b), readErr == nil
	dropIn := hostExists(dropInPath)
	obs["smb.conf"], obs["dropIn"] = current, strconv.FormatBool(dropIn)

	var steps []planStep
	if logDir := filepath.Dir(smbLogPath); req.Settings.Audit && !hostExists(logDir) {
		steps = append(steps, planStep{Kind: "create", Target: logDir,
			Summary: "Create the folder that keeps the Samba connection journal",
			run:     func() (string, error) { return "", hostMkdirPrivate(logDir) }})
	}
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
	// macOS discovery is on: keep its Time Machine records in step with the
	// shares (Avahi reloads its services folder on its own).
	if avahi := filepath.Join(avahiServicesDir, avahiServiceName); hostExists(avahi) {
		cur, _ := hostReadFile(avahi)
		want := avahiServiceFile(req.Settings.NetbiosName, timeMachineNames(req.Shares))
		obs["avahi"] = string(cur)
		if string(cur) != want {
			steps = append(steps, planStep{Kind: "update", Target: avahi,
				Summary: "Update what the NAS announces to Macs (Time Machine disks)",
				Diff:    unifiedDiff(avahi, string(cur), want),
				run:     func() (string, error) { return "", hostWriteFile(avahi, want) }})
		}
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
	return steps, nil
}
