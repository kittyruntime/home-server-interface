package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// Dashboard command widgets: a closed list of read-only commands, run without
// a shell. The dashboard names a command by its id; nothing it sends reaches
// the command line.

type widgetCommand struct {
	argv []string
	// file is read instead of running a program.
	file string
	// columns turns whitespace-separated lines into objects.
	columns []string
	// skipHeader drops the first line of a table.
	skipHeader bool
	// ndjson: one JSON value per line.
	ndjson bool
}

var widgetCommands = map[string]widgetCommand{
	"disks":          {argv: []string{"lsblk", "-J", "-b", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL"}},
	"addresses":      {argv: []string{"ip", "-j", "addr"}},
	"failed-units":   {argv: []string{"systemctl", "list-units", "--failed", "--plain", "--no-legend", "--output=json"}},
	"sensors":        {argv: []string{"sensors", "-j"}},
	"zpool":          {argv: []string{"zpool", "list", "-H", "-p", "-o", "name,size,alloc,free,health"}, columns: []string{"name", "size", "alloc", "free", "health"}},
	"mdstat":         {file: "/proc/mdstat"},
	"docker-stats":   {argv: []string{"docker", "stats", "--no-stream", "--format", "{{json .}}"}, ndjson: true},
	"journal-errors": {argv: []string{"journalctl", "-p", "err", "-n", "20", "-o", "json", "--no-pager", "--since", "-24h"}, ndjson: true},
	"df": {argv: []string{"df", "-B1", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "overlay", "--output=source,fstype,size,used,avail,target"},
		columns: []string{"source", "fstype", "size", "used", "avail", "target"}, skipHeader: true},
}

const widgetOutputMax = 256 * 1024

type cappedBuffer struct {
	bytes.Buffer
	over bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := widgetOutputMax - b.Len(); room < len(p) {
		b.over = true
		if room > 0 {
			b.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

// widgetTable turns whitespace-separated lines into objects, numbers as numbers.
func widgetTable(text string, columns []string, skipHeader bool) []map[string]any {
	out := []map[string]any{}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if skipHeader && len(lines) > 0 {
		lines = lines[1:]
	}
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < len(columns) {
			continue
		}
		// The last column takes the rest of the line (mount points with spaces).
		last := len(columns) - 1
		fields = append(fields[:last], strings.Join(fields[last:], " "))
		row := map[string]any{}
		for i, c := range columns {
			if n, err := strconv.ParseFloat(fields[i], 64); err == nil {
				row[c] = n
			} else {
				row[c] = fields[i]
			}
		}
		out = append(out, row)
	}
	return out
}

// widgetValue reads a command's output: JSON, one JSON value per line, a
// table, or text.
func widgetValue(cmd widgetCommand, text string) any {
	if cmd.columns != nil {
		return widgetTable(text, cmd.columns, cmd.skipHeader)
	}
	if cmd.ndjson {
		out := []any{}
		for _, line := range strings.Split(text, "\n") {
			var v any
			if json.Unmarshal([]byte(line), &v) == nil {
				out = append(out, v)
			}
		}
		return out
	}
	var v any
	if json.Unmarshal([]byte(text), &v) == nil {
		return v
	}
	return map[string]any{"text": text}
}

func runWidgetCommand(id string) (any, error) {
	cmd, ok := widgetCommands[id]
	if !ok {
		return nil, errors.New("unknown command")
	}
	if cmd.file != "" {
		data, err := os.ReadFile(cmd.file)
		if err != nil {
			return nil, errors.New("not available on this server")
		}
		if len(data) > widgetOutputMax {
			data = data[:widgetOutputMax]
		}
		return widgetValue(cmd, string(data)), nil
	}
	if _, err := exec.LookPath(cmd.argv[0]); err != nil {
		return nil, errors.New(cmd.argv[0] + " is not installed on this server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cmd.argv[0], cmd.argv[1:]...)
	var stdout cappedBuffer
	c.Stdout = &stdout
	c.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if err := c.Run(); err != nil && stdout.Len() == 0 {
		if ctx.Err() != nil {
			return nil, errors.New("the command took too long")
		}
		return nil, errors.New(cmd.argv[0] + " failed")
	}
	return widgetValue(cmd, stdout.String()), nil
}

// handleWidgetCommand answers root.widget.command {"id"}: {"value"}.
func handleWidgetCommand(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || req.ID == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "id is required"})
		return
	}
	value, err := runWidgetCommand(req.ID)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"value": value})
}
