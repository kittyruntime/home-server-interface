package main

import (
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
