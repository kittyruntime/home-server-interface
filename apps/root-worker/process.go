package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

// Processes for the Monitor app. The worker reads them because only root can
// see the disk activity of every account; the backend turns the counters into
// rates. Ending one checks it is still the process the admin saw (same start
// time) and never touches the system or HSI itself.

const pfKthread = 0x00200000

type procStat struct {
	pid      int
	name     string
	state    string
	ppid     int
	flags    uint64
	ticks    uint64 // utime + stime, in USER_HZ
	threads  int
	start    uint64 // since boot, in USER_HZ
	rssPages int64
}

// procInfo is one row sent to the backend.
type procInfo struct {
	Pid       int    `json:"pid"`
	Ppid      int    `json:"ppid"`
	Name      string `json:"name"`
	Cmd       string `json:"cmd"`
	User      string `json:"user"`
	State     string `json:"state"`
	Ticks     uint64 `json:"ticks"`
	Threads   int    `json:"threads"`
	Rss       int64  `json:"rss"`
	Start     string `json:"start"`
	Read      uint64 `json:"read"`
	Write     uint64 `json:"write"`
	Protected bool   `json:"protected"`
	// Kind says who the process works for: system, hsi, app or user; Owner
	// names the app or the account.
	Kind  string `json:"kind"`
	Owner string `json:"owner"`
}

var containerID = regexp.MustCompile(`(?:docker[-/]|cri-containerd-|libpod-)([0-9a-f]{64})`)

// containerFromCgroup finds the container a process runs in from
// /proc/<pid>/cgroup, or "" outside any container.
func containerFromCgroup(cgroup string) string {
	if m := containerID.FindStringSubmatch(cgroup); m != nil {
		return m[1]
	}
	return ""
}

// parseProcStat reads /proc/<pid>/stat. The name sits between the first "("
// and the last ")" and may hold spaces and parentheses itself.
func parseProcStat(line string) (procStat, error) {
	open, close := strings.IndexByte(line, '('), strings.LastIndexByte(line, ')')
	if open < 1 || close < open {
		return procStat{}, errors.New("malformed stat")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line[:open]))
	if err != nil {
		return procStat{}, err
	}
	f := strings.Fields(line[close+1:])
	if len(f) < 22 {
		return procStat{}, errors.New("short stat")
	}
	u := func(i int) uint64 { v, _ := strconv.ParseUint(f[i], 10, 64); return v }
	ppid, _ := strconv.Atoi(f[1])
	threads, _ := strconv.Atoi(f[17])
	rss, _ := strconv.ParseInt(f[21], 10, 64)
	return procStat{
		pid: pid, name: line[open+1 : close], state: f[0], ppid: ppid, flags: u(6),
		ticks: u(11) + u(12), threads: threads, start: u(19), rssPages: rss,
	}, nil
}

type procReader struct {
	root     string
	pageSize int64
	self     int
	install  string
	user     func(uid string) string
	signal   func(pid int, force bool) error
	// containers maps a container id to its app (compose project or name).
	containers func() map[string]string
}

func newProcReader() procReader {
	return procReader{
		root: "/proc", pageSize: int64(os.Getpagesize()), self: os.Getpid(), install: installRoot(),
		user: cachedUserName, containers: dockerApps, signal: func(pid int, force bool) error {
			sig := syscall.SIGTERM
			if force {
				sig = syscall.SIGKILL
			}
			return syscall.Kill(pid, sig)
		},
	}
}

var userNames sync.Map

func cachedUserName(uid string) string {
	if v, ok := userNames.Load(uid); ok {
		return v.(string)
	}
	name := uid
	if u, err := user.LookupId(uid); err == nil {
		name = u.Username
	}
	userNames.Store(uid, name)
	return name
}

var appCache struct {
	sync.Mutex
	at   time.Time
	apps map[string]string
}

// dockerApps lists running containers by id, refreshed every 10 seconds at
// most since the Monitor asks for processes every few seconds.
func dockerApps() map[string]string {
	appCache.Lock()
	defer appCache.Unlock()
	if appCache.apps != nil && time.Since(appCache.at) < 10*time.Second {
		return appCache.apps
	}
	apps := map[string]string{}
	if out, err := runDocker("ps", "--no-trunc", "--format", "{{.ID}}\t{{.Label \"com.docker.compose.project\"}}\t{{.Names}}"); err == nil {
		for _, l := range strings.Split(out, "\n") {
			f := strings.Split(l, "\t")
			if len(f) < 3 {
				continue
			}
			if f[1] != "" {
				apps[f[0]] = f[1]
			} else {
				apps[f[0]] = f[2]
			}
		}
	}
	appCache.at, appCache.apps = time.Now(), apps
	return apps
}

func (pr procReader) read(pid int) (procStat, []string, error) {
	dir := filepath.Join(pr.root, strconv.Itoa(pid))
	b, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return procStat{}, nil, err
	}
	s, err := parseProcStat(string(b))
	if err != nil {
		return procStat{}, nil, err
	}
	var cmd []string
	if c, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil {
		for _, a := range strings.Split(strings.TrimRight(string(c), "\x00"), "\x00") {
			if a != "" {
				cmd = append(cmd, a)
			}
		}
	}
	return s, cmd, nil
}

func isKernel(s procStat) bool {
	return s.pid <= 2 || s.ppid == 2 || s.flags&pfKthread != 0
}

// isHSI: this worker, the backend under the install directory, its message bus.
func (pr procReader) isHSI(s procStat, cmd []string) bool {
	if s.pid == pr.self || s.name == "nats-server" {
		return true
	}
	prefix := strings.TrimRight(pr.install, "/") + "/"
	for _, a := range cmd {
		if strings.HasPrefix(a, prefix) {
			return true
		}
	}
	return len(cmd) > 0 && filepath.Base(cmd[0]) == "nats-server"
}

// protected: init, kernel threads, and what runs HSI.
func (pr procReader) protected(s procStat, cmd []string) bool {
	return isKernel(s) || pr.isHSI(s, cmd)
}

func (pr procReader) list() []procInfo {
	entries, err := os.ReadDir(pr.root)
	if err != nil {
		return nil
	}
	out := make([]procInfo, 0, len(entries))
	var apps map[string]string // asked once, and only when a container shows up
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		s, cmd, err := pr.read(pid)
		if err != nil {
			continue // ended while listing
		}
		dir := filepath.Join(pr.root, e.Name())
		info := procInfo{
			Pid: pid, Ppid: s.ppid, Name: s.name, State: s.state, Ticks: s.ticks, Threads: s.threads,
			Rss: s.rssPages * pr.pageSize, Start: strconv.FormatUint(s.start, 10), Protected: pr.protected(s, cmd),
		}
		cmdline := strings.Join(cmd, " ")
		if len(cmdline) > 512 {
			cmdline = cmdline[:512]
		}
		info.Cmd = cmdline
		uid := -1
		if st, err := os.ReadFile(filepath.Join(dir, "status")); err == nil {
			for _, l := range strings.Split(string(st), "\n") {
				if rest, ok := strings.CutPrefix(l, "Uid:"); ok {
					if f := strings.Fields(rest); len(f) > 0 {
						uid, _ = strconv.Atoi(f[0])
						if pr.user != nil {
							info.User = pr.user(f[0])
						}
					}
					break
				}
			}
		}
		switch {
		case isKernel(s):
			info.Kind = "system"
		case pr.isHSI(s, cmd):
			info.Kind = "hsi"
		default:
			cg, _ := os.ReadFile(filepath.Join(dir, "cgroup"))
			if id := containerFromCgroup(string(cg)); id != "" {
				if apps == nil && pr.containers != nil {
					apps = pr.containers()
				}
				info.Kind, info.Owner = "app", apps[id]
				if info.Owner == "" {
					info.Owner = id[:12]
				}
			} else if uid >= 1000 && uid != 65534 {
				info.Kind, info.Owner = "user", info.User
			} else {
				info.Kind = "system"
			}
		}
		if io, err := os.ReadFile(filepath.Join(dir, "io")); err == nil {
			for _, l := range strings.Split(string(io), "\n") {
				k, v, ok := strings.Cut(l, ":")
				if !ok {
					continue
				}
				n, _ := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
				switch k {
				case "read_bytes":
					info.Read = n
				case "write_bytes":
					info.Write = n
				}
			}
		}
		out = append(out, info)
	}
	return out
}

func (pr procReader) kill(pid int, start string, force bool) *fsError {
	gone := &fsError{Code: "NOT_FOUND", Message: "This process has already ended"}
	if pid <= 0 {
		return gone
	}
	s, cmd, err := pr.read(pid)
	if err != nil || strconv.FormatUint(s.start, 10) != start {
		return gone
	}
	if pr.protected(s, cmd) {
		return &fsError{Code: "PROTECTED", Message: "This process keeps the system or HSI running and cannot be ended here"}
	}
	if err := pr.signal(pid, force); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return gone
		}
		return &fsError{Code: "ERR", Message: "could not end the process: " + err.Error()}
	}
	return nil
}

func handleProcessList(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, newProcReader().list())
}

func handleProcessKill(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Pid   int    `json:"pid"`
		Start string `json:"start"`
		Force bool   `json:"force"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, badRequest(err))
		return
	}
	if fe := newProcReader().kill(req.Pid, req.Start, req.Force); fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}
