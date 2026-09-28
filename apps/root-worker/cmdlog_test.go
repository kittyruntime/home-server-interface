package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// captureDebugLogs points the package logger at a buffer at debug level for
// the duration of a test and returns the decoded records.
func captureDebugLogs(t *testing.T) func() []map[string]any {
	t.Helper()
	var buf bytes.Buffer
	prev := logger
	logger = slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug, ReplaceAttr: replaceAttr}))
	t.Cleanup(func() { logger = prev })
	return func() []map[string]any {
		var out []map[string]any
		for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
			if line == "" {
				continue
			}
			var rec map[string]any
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				t.Fatalf("invalid log line %q: %v", line, err)
			}
			out = append(out, rec)
		}
		return out
	}
}

func TestCommandLogsSuccessAtDebug(t *testing.T) {
	records := captureDebugLogs(t)
	out, err := command("sh", "-c", "echo hello").Output()
	if err != nil || strings.TrimSpace(string(out)) != "hello" {
		t.Fatalf("Output() = %q, %v", out, err)
	}
	recs := records()
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1", len(recs))
	}
	r := recs[0]
	if r["level"] != "debug" || r["msg"] != "command succeeded" {
		t.Errorf("level/msg = %v/%v", r["level"], r["msg"])
	}
	if r["command"] != "sh -c echo hello" || r["exitCode"] != float64(0) || r["output"] != "hello" {
		t.Errorf("unexpected record: %v", r)
	}
	if _, ok := r["durationMs"]; !ok {
		t.Error("missing durationMs")
	}
}

func TestCommandLogsFailureWithExitCodeAndStderr(t *testing.T) {
	records := captureDebugLogs(t)
	_, err := command("sh", "-c", "echo out; echo boom >&2; exit 3").Output()
	if err == nil {
		t.Fatal("expected an error")
	}
	r := records()[0]
	if r["msg"] != "command failed" || r["exitCode"] != float64(3) || r["stderr"] != "boom" {
		t.Errorf("unexpected record: %v", r)
	}
}

func TestCommandRunCapturesStderrForTheLog(t *testing.T) {
	records := captureDebugLogs(t)
	if err := command("sh", "-c", "echo nope >&2; exit 1").Run(); err == nil {
		t.Fatal("expected an error")
	}
	if r := records()[0]; r["stderr"] != "nope" || r["exitCode"] != float64(1) {
		t.Errorf("unexpected record: %v", r)
	}
}

func TestCommandNeverLogsStdin(t *testing.T) {
	records := captureDebugLogs(t)
	cmd := command("cat")
	cmd.Stdin = strings.NewReader("s3cret")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	for _, r := range records() {
		b, _ := json.Marshal(r)
		if strings.Contains(string(b), "s3cret") {
			t.Fatalf("stdin leaked into the log: %s", b)
		}
	}
}

func TestCommandTrimsLongOutput(t *testing.T) {
	records := captureDebugLogs(t)
	if _, err := command("sh", "-c", "head -c 10000 /dev/zero | tr '\\0' a; echo END").CombinedOutput(); err != nil {
		t.Fatal(err)
	}
	out, _ := records()[0]["output"].(string)
	if len(out) > maxLoggedOutput+len("…") || !strings.HasSuffix(out, "END") {
		t.Errorf("output not tail-trimmed: len=%d", len(out))
	}
}

func TestCommandSkipsWorkWhenDebugDisabled(t *testing.T) {
	var buf bytes.Buffer
	prev := logger
	logger = slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	t.Cleanup(func() { logger = prev })
	cmd := command("sh", "-c", "exit 1")
	_ = cmd.Run()
	if buf.Len() != 0 {
		t.Errorf("logged at info level: %s", buf.String())
	}
	if cmd.Stderr != nil {
		t.Error("Run() should not capture stderr when debug is off")
	}
}
