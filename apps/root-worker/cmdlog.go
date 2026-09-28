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
type loggedCmd struct{ *exec.Cmd }

func command(name string, args ...string) *loggedCmd {
	return &loggedCmd{exec.Command(name, args...)}
}

func commandContext(ctx context.Context, name string, args ...string) *loggedCmd {
	return &loggedCmd{exec.CommandContext(ctx, name, args...)}
}

func debugEnabled() bool {
	return logger.Enabled(context.Background(), slog.LevelDebug)
}

func (c *loggedCmd) Run() error {
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
