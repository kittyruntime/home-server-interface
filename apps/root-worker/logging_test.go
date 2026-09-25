package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	nats "github.com/nats-io/nats.go"
)

func TestParseLogLevel(t *testing.T) {
	cases := map[string]slog.Level{
		"":        slog.LevelInfo,
		"debug":   slog.LevelDebug,
		"DEBUG":   slog.LevelDebug,
		"warn":    slog.LevelWarn,
		"warning": slog.LevelWarn,
		"error":   slog.LevelError,
		"bogus":   slog.LevelInfo,
	}
	for in, want := range cases {
		if got := parseLogLevel(in); got != want {
			t.Errorf("parseLogLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestServeSyncRecoversPanics(t *testing.T) {
	// A nil *nats.Conn makes replyErr's Publish fail; the point is that the
	// panic is recovered and does not crash the test process.
	serveSync(nil, "root.test.panic", func(_ *nats.Conn, _ *nats.Msg) { panic("boom") }, &nats.Msg{})
}

func TestLogLineShape(t *testing.T) {
	var buf bytes.Buffer
	l := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{ReplaceAttr: replaceAttr})).With("component", "worker")
	l.Warn("job failed", "jobId", "abc")
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("not JSON: %q", buf.String())
	}
	if line["level"] != "warn" || line["component"] != "worker" || line["msg"] != "job failed" || line["time"] == nil {
		t.Errorf("unexpected log line: %v", line)
	}
}
