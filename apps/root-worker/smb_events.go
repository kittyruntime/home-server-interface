package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

// Connections and refusals read from smbd's log (smbLogPath), which the
// rendered smb.conf fills with JSON authentication audit lines and
// vfs_full_audit connect/disconnect lines. Nothing about files is read.

type smbEvent struct {
	At      time.Time `json:"at"`
	Kind    string    `json:"kind"`   // "auth" | "connect" | "disconnect"
	Result  string    `json:"result"` // "ok" | "refused"
	Reason  string    `json:"reason,omitempty"`
	User    string    `json:"user,omitempty"`
	IP      string    `json:"ip,omitempty"`
	Machine string    `json:"machine,omitempty"`
	Share   string    `json:"share,omitempty"`
}

type smbCursor struct {
	Inode  uint64 `json:"inode"`
	Offset int64  `json:"offset"`
}

var (
	reSmbLogHeader = regexp.MustCompile(`^\[(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}\.\d+),[^\]]*\] (\S+)`)
	reNotPermitted = regexp.MustCompile(`user '([^']*)' \(from session setup\) not permitted to access this share \(([^)]*)\)`)
)

var authReasons = map[string]string{
	"NT_STATUS_WRONG_PASSWORD":     "wrong_password",
	"NT_STATUS_NO_SUCH_USER":       "unknown_user",
	"NT_STATUS_ACCOUNT_DISABLED":   "account_disabled",
	"NT_STATUS_ACCOUNT_LOCKED_OUT": "account_disabled",
}

// smbLogParser keeps what one line needs from earlier ones: the header's
// time and source, and each user's latest authenticated address (smbd's
// "not permitted" line names the user but not the client).
type smbLogParser struct {
	at       time.Time
	source   string
	lastAuth map[string]string
}

func newSmbLogParser() *smbLogParser { return &smbLogParser{lastAuth: map[string]string{}} }

// smbAddr turns Samba's "ipv4:1.2.3.4:445", "ipv6:fe80::1:445" (no
// brackets) or "ipv6:[fe80::1]:445" into the bare address, zone dropped.
func smbAddr(s string) string {
	var host string
	switch {
	case strings.HasPrefix(s, "ipv6:["):
		rest := strings.TrimPrefix(s, "ipv6:[")
		i := strings.Index(rest, "]")
		if i < 0 {
			return ""
		}
		host = rest[:i]
	case strings.HasPrefix(s, "ipv6:"), strings.HasPrefix(s, "ipv4:"):
		rest := s[5:]
		i := strings.LastIndex(rest, ":")
		if i < 0 {
			return ""
		}
		host = rest[:i]
	default:
		host = s
	}
	if i := strings.Index(host, "%"); i >= 0 {
		host = host[:i]
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return ""
}

func (p *smbLogParser) line(l string) (smbEvent, bool) {
	if m := reSmbLogHeader.FindStringSubmatch(l); m != nil {
		if t, err := time.ParseInLocation("2006/01/02 15:04:05.000000", m[1], time.Local); err == nil {
			p.at = t
		}
		p.source = m[2]
		return smbEvent{}, false
	}
	msg := strings.TrimSpace(l)
	switch {
	case strings.HasPrefix(msg, "{"):
		return p.auth(msg)
	case strings.HasPrefix(p.source, "source3/modules/vfs_full_audit.c"):
		f := strings.Split(msg, "|")
		if len(f) != 7 || (f[4] != "connect" && f[4] != "disconnect") || f[0] == "" {
			return smbEvent{}, false
		}
		ev := smbEvent{At: p.at, Kind: f[4], Result: "ok", User: f[0], IP: smbAddr(f[1]), Machine: f[2], Share: f[3]}
		if f[5] != "ok" {
			ev.Result, ev.Reason = "refused", "no_access"
		}
		return ev, true
	case strings.HasPrefix(msg, "Denied connection from "):
		ip := strings.Fields(strings.TrimPrefix(msg, "Denied connection from "))
		if len(ip) == 0 {
			return smbEvent{}, false
		}
		return smbEvent{At: p.at, Kind: "connect", Result: "refused", Reason: "blocked", IP: smbAddr(ip[0])}, true
	}
	if m := reNotPermitted.FindStringSubmatch(msg); m != nil {
		return smbEvent{At: p.at, Kind: "connect", Result: "refused", Reason: "no_access",
			User: m[1], IP: p.lastAuth[m[1]], Share: m[2]}, true
	}
	return smbEvent{}, false
}

func (p *smbLogParser) auth(msg string) (smbEvent, bool) {
	var raw struct {
		Timestamp string `json:"timestamp"`
		Type      string `json:"type"`
		Auth      *struct {
			Status        string `json:"status"`
			RemoteAddress string `json:"remoteAddress"`
			ClientAccount string `json:"clientAccount"`
			Workstation   string `json:"workstation"`
		} `json:"Authentication"`
	}
	if json.Unmarshal([]byte(msg), &raw) != nil || raw.Type != "Authentication" || raw.Auth == nil {
		return smbEvent{}, false
	}
	a := raw.Auth
	// Anonymous sessions (share listing before a login) are not a person.
	if a.ClientAccount == "" {
		return smbEvent{}, false
	}
	at, err := time.Parse("2006-01-02T15:04:05.999999-0700", raw.Timestamp)
	if err != nil {
		at = p.at
	}
	ev := smbEvent{At: at, Kind: "auth", Result: "ok", User: a.ClientAccount, IP: smbAddr(a.RemoteAddress), Machine: a.Workstation}
	if a.Status != "NT_STATUS_OK" {
		ev.Result = "refused"
		ev.Reason = authReasons[a.Status]
		if ev.Reason == "" {
			ev.Reason = "other"
		}
	} else {
		p.lastAuth[ev.User] = ev.IP
	}
	return ev, true
}

func parseSmbLog(r io.Reader) []smbEvent {
	p := newSmbLogParser()
	var out []smbEvent
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), maxSmbLogLine)
	for sc.Scan() {
		if ev, ok := p.line(sc.Text()); ok {
			out = append(out, ev)
		}
	}
	return out
}

// maxSmbLogLine bounds one line; a longer one is skipped, never buffered whole.
const maxSmbLogLine = 256 * 1024

// The parser outlives one read: an auth line and the share refusal that
// follows it can land in two reads.
var (
	smbEventsMu     sync.Mutex
	smbEventsParser = newSmbLogParser()
)

// readSmbEvents returns the events of the complete lines after c, reading
// about maxBytes (a single longer line is still read whole). A replaced or
// truncated file is read again from its start.
func readSmbEvents(path string, c smbCursor, maxBytes int64) ([]smbEvent, smbCursor, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, c, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, c, err
	}
	var inode uint64
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		inode = s.Ino
	}
	if inode != c.Inode || st.Size() < c.Offset {
		c = smbCursor{Inode: inode}
	}
	if _, err := f.Seek(c.Offset, io.SeekStart); err != nil {
		return nil, c, err
	}
	smbEventsMu.Lock()
	defer smbEventsMu.Unlock()
	var out []smbEvent
	br := bufio.NewReaderSize(f, 64*1024)
	var read int64
	for read < maxBytes {
		line, consumed, err := readSmbLogLine(br)
		if errors.Is(err, io.EOF) {
			break // a partial last line waits for its newline
		}
		if err != nil {
			return out, c, err
		}
		read += consumed
		c.Offset += consumed
		if ev, ok := smbEventsParser.line(string(bytes.TrimRight(line, "\n"))); ok {
			out = append(out, ev)
		}
	}
	return out, c, nil
}

// readSmbLogLine returns one line with its newline and the bytes it used.
// A line over maxSmbLogLine is consumed but comes back empty, so it is
// skipped without ever being held whole.
func readSmbLogLine(br *bufio.Reader) ([]byte, int64, error) {
	var buf []byte
	var n int64
	for {
		chunk, err := br.ReadSlice('\n')
		n += int64(len(chunk))
		if n <= maxSmbLogLine {
			buf = append(buf, chunk...)
		}
		switch {
		case err == nil:
			if n > maxSmbLogLine {
				return nil, n, nil
			}
			return buf, n, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			return nil, n, err
		}
	}
}

func handleSharingEvents(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Cursor smbCursor `json:"cursor"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	evs, c, err := readSmbEvents(smbLogPath, req.Cursor, 1<<20)
	if os.IsNotExist(err) {
		replyOk(nc, msg.Reply, map[string]any{"events": []smbEvent{}, "cursor": req.Cursor, "available": false})
		return
	}
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if evs == nil {
		evs = []smbEvent{}
	}
	replyOk(nc, msg.Reply, map[string]any{"events": evs, "cursor": c, "available": true})
}
