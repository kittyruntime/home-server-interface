package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os/exec"
	"strings"
	"time"
)

// maxLoggedOutput caps the stdout/stderr kept in a command log record. The
// tail is kept: errors are usually printed last.
const maxLoggedOutput = 2000

// loggedCmd is an exec.Cmd whose Run, Output and CombinedOutput trace the
// command at debug level: command line, duration, exit code and trimmed
// output. Failures are logged at debug too: many probes fail routinely
// (blkid on a blank disk, smartctl's bitmask exit codes), and a failure that
// matters already reaches the log through the job or request error.
//
// Secrets must only be passed on stdin, which is never logged.
type loggedCmd struct {
	*exec.Cmd
	cancel context.CancelFunc // set by probe, released once the command ends
}

func command(name string, args ...string) *loggedCmd {
	return &loggedCmd{Cmd: exec.Command(name, args...)}
}

func commandContext(ctx context.Context, name string, args ...string) *loggedCmd {
	return &loggedCmd{Cmd: exec.CommandContext(ctx, name, args...)}
}

// probeTimeout bounds a read-only host query. NATS delivers a subject's
// messages one at a time, so a probe stuck on a dying disk or a stale mount
// would otherwise block that subject for good.
var probeTimeout = 60 * time.Second

// probe is command for quick read-only queries (lsblk, blkid, findmnt,
// smartctl, mdadm --detail...): it is killed after probeTimeout. Commands
// that change the host or move data use command, they can take hours.
func probe(name string, args ...string) *loggedCmd {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	c := &loggedCmd{Cmd: exec.CommandContext(ctx, name, args...), cancel: cancel}
	// A child that keeps the output pipes open must not outlive the kill.
	c.WaitDelay = 5 * time.Second
	return c
}

func (c *loggedCmd) release() {
	if c.cancel != nil {
		c.cancel()
	}
}

func debugEnabled() bool {
	return logger.Enabled(context.Background(), slog.LevelDebug)
}

func (c *loggedCmd) Run() error {
	defer c.release()
	if !debugEnabled() {
		return c.Cmd.Run()
	}
	var stderr *bytes.Buffer
	if c.Stderr == nil {
		stderr = &bytes.Buffer{}
		c.Stderr = stderr
	}
	start := time.Now()
	err := c.Cmd.Run()
	var errOut []byte
	if stderr != nil {
		errOut = stderr.Bytes()
	}
	c.log(start, err, nil, errOut)
	return err
}

func (c *loggedCmd) Output() ([]byte, error) {
	defer c.release()
	if !debugEnabled() {
		return c.Cmd.Output()
	}
	start := time.Now()
	out, err := c.Cmd.Output()
	var errOut []byte
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		errOut = ee.Stderr
	}
	c.log(start, err, out, errOut)
	return out, err
}

func (c *loggedCmd) CombinedOutput() ([]byte, error) {
	defer c.release()
	if !debugEnabled() {
		return c.Cmd.CombinedOutput()
	}
	start := time.Now()
	out, err := c.Cmd.CombinedOutput()
	c.log(start, err, out, nil)
	return out, err
}

func (c *loggedCmd) log(start time.Time, err error, out, errOut []byte) {
	attrs := []any{
		"command", strings.Join(c.Args, " "),
		"durationMs", time.Since(start).Milliseconds(),
	}
	exitCode := 0
	if err != nil {
		exitCode = -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else {
			attrs = append(attrs, "error", err.Error())
		}
	}
	attrs = append(attrs, "exitCode", exitCode)
	if s := trimOutput(out); s != "" {
		attrs = append(attrs, "output", s)
	}
	if s := trimOutput(errOut); s != "" {
		attrs = append(attrs, "stderr", s)
	}
	msg := "command succeeded"
	if err != nil {
		msg = "command failed"
	}
	logger.Debug(msg, attrs...)
}

func trimOutput(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > maxLoggedOutput {
		s = "…" + s[len(s)-maxLoggedOutput:]
	}
	return s
}
