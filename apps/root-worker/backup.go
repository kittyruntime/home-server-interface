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

func doRsyncBackup(task taskMsg) (interface{}, *fsError) {
	source, err := cleanBackupPath(task.Source)
	if err != nil {
		return nil, toFsErr(err)
	}
	destination, err := cleanBackupPath(task.Destination)
	if err != nil {
		return nil, toFsErr(err)
	}
	remote := task.RemoteHost != ""
	if remote {
		if !backupHost.MatchString(task.RemoteHost) || !backupUser.MatchString(task.RemoteUser) {
			return nil, toFsErr(fmt.Errorf("invalid remote endpoint"))
		}
		if task.RemotePort < 1 || task.RemotePort > 65535 {
			return nil, toFsErr(fmt.Errorf("invalid SSH port"))
		}
		key, e := cleanBackupPath(task.SSHKeyPath)
		if e != nil {
			return nil, toFsErr(fmt.Errorf("invalid SSH key path"))
		}
		info, e := os.Stat(key)
		if e != nil || !info.Mode().IsRegular() {
			return nil, toFsErr(fmt.Errorf("SSH key is not a regular file"))
		}
		if info.Mode().Perm()&0077 != 0 {
			return nil, toFsErr(fmt.Errorf("SSH key permissions must be 0600 or stricter"))
		}
		task.SSHKeyPath = key
	}
	if task.Direction != "push" && task.Direction != "pull" {
		return nil, toFsErr(fmt.Errorf("invalid backup direction"))
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
			return nil, toFsErr(fmt.Errorf("invalid exclusion pattern"))
		}
		args = append(args, "--exclude="+exclude)
	}
	endpoint := task.RemoteUser + "@" + task.RemoteHost + ":"
	if remote {
		ssh := fmt.Sprintf("ssh -i %s -p %d -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes", task.SSHKeyPath, task.RemotePort)
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
		return nil, &fsError{Code: "ERR", Message: fmt.Sprintf("rsync failed: %s", strings.TrimSpace(message))}
	}
	text := output.String()
	if len(text) > 12000 {
		text = text[len(text)-12000:]
	}
	return map[string]interface{}{"ok": true, "summary": text}, nil
}
