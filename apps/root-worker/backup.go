package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var backupHost = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`)
var backupUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

func cleanBackupPath(p string) (string, error) {
	if !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n") {
		return "", fmt.Errorf("invalid absolute backup path")
	}
	clean := filepath.Clean(p)
	if clean == "/" {
		return "", fmt.Errorf("filesystem root cannot be backed up directly")
	}
	return clean, nil
}

// doRsyncBackup is the root.backup.rsync job, kept until its last caller is gone.
func doRsyncBackup(task taskMsg) (interface{}, *fsError) {
	summary, err := runRsync(task)
	if err != nil {
		return nil, toFsErr(err)
	}
	return map[string]interface{}{"ok": true, "summary": summary}, nil
}

// rsyncShell is the ssh command of --rsh, which rsync splits on spaces. It is ""
// when the key path could add an option.
func rsyncShell(key string, port int) string {
	if validSSHKeyPath(key) != nil {
		return ""
	}
	return fmt.Sprintf("ssh -i %s -p %d -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes", key, port)
}

// runRsync validates the task, runs rsync and returns the tail of its output.
func runRsync(task taskMsg) (string, error) {
	source, err := cleanBackupPath(task.Source)
	if err != nil {
		return "", err
	}
	destination, err := cleanBackupPath(task.Destination)
	if err != nil {
		return "", err
	}
	remote := task.RemoteHost != ""
	if remote {
		if !backupHost.MatchString(task.RemoteHost) || !backupUser.MatchString(task.RemoteUser) {
			return "", fmt.Errorf("invalid remote endpoint")
		}
		if task.RemotePort < 1 || task.RemotePort > 65535 {
			return "", fmt.Errorf("invalid SSH port")
		}
		if e := validSSHKeyPath(task.SSHKeyPath); e != nil {
			return "", e
		}
		key := task.SSHKeyPath
		info, e := os.Stat(key)
		if e != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("SSH key is not a regular file")
		}
		if info.Mode().Perm()&0077 != 0 {
			return "", fmt.Errorf("SSH key permissions must be 0600 or stricter")
		}
		task.SSHKeyPath = key
	}
	if task.Direction != "push" && task.Direction != "pull" {
		return "", fmt.Errorf("invalid backup direction")
	}
	args := []string{"--archive", "--human-readable", "--stats", "--protect-args", "--partial", "--numeric-ids"}
	if task.Compress {
		args = append(args, "--compress")
	}
	if task.DeleteExtra {
		args = append(args, "--delete-delay")
	}
	if task.BandwidthLimit > 0 {
		args = append(args, "--bwlimit="+strconv.Itoa(task.BandwidthLimit))
	}
	for _, exclude := range task.Excludes {
		if exclude == "" || strings.ContainsAny(exclude, "\x00\r\n") {
			return "", fmt.Errorf("invalid exclusion pattern")
		}
		args = append(args, "--exclude="+exclude)
	}
	endpoint := task.RemoteUser + "@" + task.RemoteHost + ":"
	if remote {
		ssh := rsyncShell(task.SSHKeyPath, task.RemotePort)
		if ssh == "" {
			return "", fmt.Errorf("invalid SSH key path")
		}
		args = append(args, "--rsh="+ssh)
	}
	src, dst := source+"/", destination+"/"
	if remote && task.Direction == "push" {
		dst = endpoint + dst
	}
	if remote && task.Direction == "pull" {
		src = endpoint + src
	}
	args = append(args, "--", src, dst)
	cmd := command("rsync", args...)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		message := output.String()
		if len(message) > 12000 {
			message = message[len(message)-12000:]
		}
		return "", fmt.Errorf("rsync failed: %s", strings.TrimSpace(message))
	}
	text := output.String()
	if len(text) > 12000 {
		text = text[len(text)-12000:]
	}
	return text, nil
}
