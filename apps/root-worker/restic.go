package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func resticPath() string {
	return envOr("HSI_RESTIC", "/usr/local/lib/hsi/restic")
}

func minimalEnv() []string {
	return []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=" + backupStateDir(), "LANG=C.UTF-8"}
}

const resticStderrTail = 4000

// runRestic runs restic with env and args; onLine receives each stdout line (nil to ignore).
// It returns the exit code (0 ok), the stderr tail and an error only when restic could not start.
var runRestic = func(env, args []string, onLine func([]byte)) (int, string, error) {
	cmd := exec.Command(resticPath(), args...)
	cmd.Env = append(minimalEnv(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return -1, "", err
	}
	if err := cmd.Start(); err != nil {
		return -1, "", err
	}
	// No line length limit: "snapshots --json" prints its whole array on one line.
	rd := bufio.NewReader(out)
	for {
		line, rerr := rd.ReadBytes('\n')
		if len(line) > 0 && onLine != nil {
			onLine(bytes.TrimRight(line, "\r\n"))
		}
		if rerr != nil {
			break
		}
	}
	code := 0
	if err := cmd.Wait(); err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			return -1, "", err
		}
		code = ee.ExitCode()
	}
	tail := stderr.Bytes()
	if len(tail) > resticStderrTail {
		tail = tail[len(tail)-resticStderrTail:]
	}
	return code, string(tail), nil
}

func resticVersion() (string, bool) {
	if _, err := os.Stat(resticPath()); err != nil {
		return "", false
	}
	var raw []byte
	code, _, err := runRestic(nil, []string{"version", "--json"}, func(l []byte) { raw = append(raw, l...) })
	if err != nil || code != 0 {
		return "", false
	}
	var v struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &v) != nil || v.Version == "" {
		return "", false
	}
	return v.Version, true
}

func resticRepository(r repositoryCfg) string {
	switch r.Type {
	case "sftp":
		return fmt.Sprintf("sftp://%s@%s:%d/%s", r.User, r.Host, r.Port, r.Path)
	case "s3":
		repo := "s3:https://" + r.Endpoint + "/" + r.Bucket
		if r.Path != "" {
			repo += "/" + r.Path
		}
		return repo
	case "rest":
		return "rest:" + r.URL
	}
	return r.Path
}

// resticEnv carries the repository and every secret, they never go in argv.
func resticEnv(r repositoryCfg, s repoSecrets) []string {
	env := []string{"RESTIC_REPOSITORY=" + resticRepository(r), "RESTIC_PASSWORD=" + s.Password}
	switch r.Type {
	case "s3":
		env = append(env, "AWS_ACCESS_KEY_ID="+s.AccessKeyID, "AWS_SECRET_ACCESS_KEY="+s.SecretAccessKey)
	case "rest":
		env = append(env, "RESTIC_REST_USERNAME="+s.RestUser, "RESTIC_REST_PASSWORD="+s.RestPassword)
	}
	return env
}

func resticGlobalArgs(r repositoryCfg, s repoSecrets) []string {
	if r.Type != "sftp" {
		return nil
	}
	return []string{"-o", "sftp.args=-i " + s.SSHKeyPath + " -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"}
}

// resticCmd runs restic with the leading words first (subcommand and its positional
// arguments), then the global flags, then the command's own arguments.
func resticCmd(r repositoryCfg, s repoSecrets, lead []string, own []string, onLine func([]byte)) (int, string, error) {
	args := append([]string{}, lead...)
	args = append(args, "--cache-dir", filepath.Join(backupStateDir(), "cache"))
	args = append(args, resticGlobalArgs(r, s)...)
	args = append(args, own...)
	return runRestic(resticEnv(r, s), args, onLine)
}

// resticRun runs a command whose output is not parsed and turns a failure into an error.
func resticRun(r repositoryCfg, s repoSecrets, sub string, own ...string) error {
	code, stderr, err := resticCmd(r, s, []string{sub}, own, nil)
	return resticResult(sub, code, stderr, err)
}

func resticResult(sub string, code int, stderr string, err error) error {
	if err != nil {
		return fmt.Errorf("restic %s could not start: %w", sub, err)
	}
	if code != 0 {
		return fmt.Errorf("restic %s failed: %s", sub, strings.TrimSpace(stderr))
	}
	return nil
}

type probeState string

const (
	probeEmpty         probeState = "empty"
	probeRepository    probeState = "repository"
	probeWrongPassword probeState = "wrongPassword"
	probeUnreachable   probeState = "unreachable"
)

func resticProbe(r repositoryCfg, s repoSecrets) (probeState, string) {
	code, stderr, err := resticCmd(r, s, []string{"cat"}, []string{"config"}, nil)
	if err != nil {
		return probeUnreachable, err.Error()
	}
	switch code {
	case 0:
		return probeRepository, ""
	case 10:
		return probeEmpty, ""
	case 12:
		return probeWrongPassword, ""
	}
	return probeUnreachable, strings.TrimSpace(stderr)
}

func resticInit(r repositoryCfg, s repoSecrets) error {
	return resticRun(r, s, "init")
}

type backupProgress struct {
	PercentDone float64 `json:"percentDone"`
	FilesDone   int     `json:"filesDone"`
	TotalFiles  int     `json:"totalFiles"`
	BytesDone   int64   `json:"bytesDone"`
	TotalBytes  int64   `json:"totalBytes"`
}

type backupSummary struct {
	SnapshotID      string
	FilesNew        int
	FilesChanged    int
	FilesUnmodified int
	DataAdded       int64
	Partial         bool
	Warning         string
}

type resticLine struct {
	MessageType     string  `json:"message_type"`
	PercentDone     float64 `json:"percent_done"`
	FilesDone       int     `json:"files_done"`
	TotalFiles      int     `json:"total_files"`
	BytesDone       int64   `json:"bytes_done"`
	TotalBytes      int64   `json:"total_bytes"`
	SnapshotID      string  `json:"snapshot_id"`
	FilesNew        int     `json:"files_new"`
	FilesChanged    int     `json:"files_changed"`
	FilesUnmodified int     `json:"files_unmodified"`
	DataAdded       int64   `json:"data_added"`
	FilesRestored   int     `json:"files_restored"`
	FilesSkipped    int     `json:"files_skipped"`
	BytesRestored   int64   `json:"bytes_restored"`
	Item            string  `json:"item"`
	Error           struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (l resticLine) progress() backupProgress {
	return backupProgress{l.PercentDone, l.FilesDone, l.TotalFiles, l.BytesDone, l.TotalBytes}
}

const maxWarningItems = 5

func resticBackup(r repositoryCfg, s repoSecrets, sources, excludes, tags []string, onProgress func(backupProgress)) (backupSummary, error) {
	own := []string{"--json", "--retry-lock", "10m"}
	for _, t := range tags {
		own = append(own, "--tag", t)
	}
	for _, e := range excludes {
		own = append(own, "--exclude", e)
	}
	own = append(own, "--")
	own = append(own, sources...)

	var sum backupSummary
	var gotSummary bool
	var warnings []string
	skipped := 0
	code, stderr, err := resticCmd(r, s, []string{"backup"}, own, func(b []byte) {
		var l resticLine
		if json.Unmarshal(b, &l) != nil {
			return
		}
		switch l.MessageType {
		case "status":
			if onProgress != nil {
				onProgress(l.progress())
			}
		case "summary":
			gotSummary = true
			sum.SnapshotID = l.SnapshotID
			sum.FilesNew, sum.FilesChanged, sum.FilesUnmodified = l.FilesNew, l.FilesChanged, l.FilesUnmodified
			sum.DataAdded = l.DataAdded
		case "error":
			if len(warnings) < maxWarningItems {
				msg := l.Error.Message
				if l.Item != "" && !strings.Contains(msg, l.Item) {
					msg = l.Item + ": " + msg
				}
				warnings = append(warnings, msg)
			} else {
				skipped++
			}
		}
	})
	if err != nil {
		return sum, fmt.Errorf("restic backup could not start: %w", err)
	}
	if code == 3 && gotSummary {
		sum.Partial = true
		sum.Warning = strings.Join(warnings, "; ")
		if skipped > 0 {
			sum.Warning += fmt.Sprintf("; and %d more", skipped)
		}
		return sum, nil
	}
	if code != 0 {
		return sum, fmt.Errorf("restic backup failed: %s", strings.TrimSpace(stderr))
	}
	if !gotSummary {
		return sum, fmt.Errorf("restic backup printed no summary")
	}
	return sum, nil
}

func resticForget(r repositoryCfg, s repoSecrets, planID string, keep retentionPolicy) error {
	own := []string{"--prune", "--retry-lock", "10m", "--tag", "plan:" + planID}
	for _, k := range []struct {
		flag string
		n    int
	}{{"--keep-last", keep.KeepLast}, {"--keep-daily", keep.KeepDaily}, {"--keep-weekly", keep.KeepWeekly}, {"--keep-monthly", keep.KeepMonthly}} {
		if k.n > 0 {
			own = append(own, k.flag, fmt.Sprint(k.n))
		}
	}
	return resticRun(r, s, "forget", own...)
}

type snapshot struct {
	ID      string    `json:"id"`
	ShortID string    `json:"shortId"`
	Time    time.Time `json:"time"`
	Paths   []string  `json:"paths"`
	Tags    []string  `json:"tags"`
}

func resticSnapshots(r repositoryCfg, s repoSecrets) ([]snapshot, error) {
	var raw []byte
	code, stderr, err := resticCmd(r, s, []string{"snapshots"}, []string{"--json"}, func(l []byte) { raw = append(raw, l...) })
	if err := resticResult("snapshots", code, stderr, err); err != nil {
		return nil, err
	}
	var list []struct {
		ID      string    `json:"id"`
		ShortID string    `json:"short_id"`
		Time    time.Time `json:"time"`
		Paths   []string  `json:"paths"`
		Tags    []string  `json:"tags"`
	}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("restic snapshots: %w", err)
		}
	}
	out := make([]snapshot, 0, len(list))
	for _, e := range list {
		out = append(out, snapshot{e.ID, e.ShortID, e.Time, e.Paths, e.Tags})
	}
	return out, nil
}

type lsEntry struct {
	Name  string    `json:"name"`
	Path  string    `json:"path"`
	Type  string    `json:"type"`
	Size  int64     `json:"size"`
	Mtime time.Time `json:"mtime"`
}

// resticLs lists the direct children of dir in a snapshot.
func resticLs(r repositoryCfg, s repoSecrets, snapshotID, dir string) ([]lsEntry, error) {
	dir = filepath.Clean(dir)
	entries := []lsEntry{}
	code, stderr, err := resticCmd(r, s, []string{"ls", snapshotID}, []string{"--json", dir}, func(b []byte) {
		var n struct {
			StructType string `json:"struct_type"`
			lsEntry
		}
		if json.Unmarshal(b, &n) != nil || n.StructType != "node" {
			return
		}
		if filepath.Dir(n.Path) == dir {
			entries = append(entries, n.lsEntry)
		}
	})
	if err := resticResult("ls", code, stderr, err); err != nil {
		return nil, err
	}
	return entries, nil
}

type restoreSummary struct {
	FilesRestored int      `json:"filesRestored"`
	FilesSkipped  int      `json:"filesSkipped"`
	TotalFiles    int      `json:"totalFiles"`
	BytesRestored int64    `json:"bytesRestored"`
	Warnings      []string `json:"warnings"`
}

// resticRestore never passes --delete, so nothing at the target is removed.
func resticRestore(r repositoryCfg, s repoSecrets, snapshotID, include, target string, dryRun bool, onProgress func(backupProgress)) (restoreSummary, error) {
	own := []string{"--json", "--retry-lock", "10m", "--target", target, "--include", include}
	if dryRun {
		own = append(own, "--dry-run")
	}
	var sum restoreSummary
	code, stderr, err := resticCmd(r, s, []string{"restore", snapshotID}, own, func(b []byte) {
		var l resticLine
		if json.Unmarshal(b, &l) != nil {
			return
		}
		switch l.MessageType {
		case "status":
			if onProgress != nil {
				p := l.progress()
				p.FilesDone, p.BytesDone = l.FilesRestored, l.BytesRestored
				onProgress(p)
			}
		case "summary":
			sum.FilesRestored, sum.FilesSkipped, sum.TotalFiles, sum.BytesRestored = l.FilesRestored, l.FilesSkipped, l.TotalFiles, l.BytesRestored
		case "error":
			sum.Warnings = append(sum.Warnings, l.Error.Message)
		}
	})
	if err := resticResult("restore", code, stderr, err); err != nil {
		return sum, err
	}
	return sum, nil
}

func resticCheck(r repositoryCfg, s repoSecrets, subset string) error {
	own := []string{"--retry-lock", "10m"}
	if subset == "" {
		own = append(own, "--read-data")
	} else {
		own = append(own, "--read-data-subset", subset)
	}
	return resticRun(r, s, "check", own...)
}
