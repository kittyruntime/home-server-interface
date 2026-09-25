package main

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	nats "github.com/nats-io/nats.go"
)

// Structured JSON logs on stderr (appended to root-worker.log by systemd), in
// the same shape as the backend's pino logs. HSI_LOG_LEVEL (debug, info, warn,
// error; default info) is read from worker.env. `debug` also logs successful
// synchronous requests.
var logger = newLogger(os.Getenv("HSI_LOG_LEVEL"))

func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func newLogger(level string) *slog.Logger {
	l := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: parseLogLevel(level)}))
	// Route the remaining log.Printf calls through the same handler.
	slog.SetDefault(l)
	return l
}

// inflight maps a request's reply inbox to its subject, so replyErr can say
// which request failed without threading the subject through every handler.
var inflight sync.Map

// serveSync runs a synchronous request handler with logging and panic
// recovery: a panicking handler replies with an error instead of crashing the
// worker.
func serveSync(nc *nats.Conn, subject string, h func(*nats.Conn, *nats.Msg), msg *nats.Msg) {
	start := time.Now()
	if msg.Reply != "" {
		inflight.Store(msg.Reply, subject)
		defer inflight.Delete(msg.Reply)
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Error("request panicked", "subject", subject, "panic", fmt.Sprint(r))
			replyErr(nc, msg.Reply, &fsError{Code: "EINTERNAL", Message: fmt.Sprintf("internal error in %s", subject)})
		}
	}()
	h(nc, msg)
	logger.Debug("request handled", "subject", subject, "durationMs", time.Since(start).Milliseconds())
}

func logReplyError(replySubject string, e *fsError) {
	subject, _ := inflight.Load(replySubject)
	logger.Warn("request failed", "subject", subject, "code", e.Code, "error", e.Message)
}
