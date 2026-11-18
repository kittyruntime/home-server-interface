package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// fakeProc writes one /proc/<pid> entry under root.
func fakeProc(t *testing.T, root string, pid int, stat, status, cmdline, io string) {
	t.Helper()
	dir := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"stat": stat, "status": status, "cmdline": cmdline, "io": io} {
		if body == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// statLine builds a /proc/<pid>/stat line; fields after comm start at state.
func statLine(pid int, comm, state string, ppid int, flags uint64, utime, stime uint64, threads int, start uint64, rssPages int) string {
	f := make([]string, 50)
	for i := range f {
		f[i] = "0"
	}
	f[0] = state
	f[1] = strconv.Itoa(ppid)
	f[6] = strconv.FormatUint(flags, 10)
	f[11] = strconv.FormatUint(utime, 10)
	f[12] = strconv.FormatUint(stime, 10)
	f[17] = strconv.Itoa(threads)
	f[19] = strconv.FormatUint(start, 10)
	f[21] = strconv.Itoa(rssPages)
	line := strconv.Itoa(pid) + " (" + comm + ")"
	for _, v := range f {
		line += " " + v
	}
	return line + "\n"
}

func TestParseProcStatKeepsParensInName(t *testing.T) {
	s, err := parseProcStat(statLine(42, "tmux: server (1)", "S", 1, 0, 120, 30, 3, 9876, 512))
	if err != nil {
		t.Fatal(err)
	}
	if s.name != "tmux: server (1)" || s.state != "S" || s.ppid != 1 || s.ticks != 150 || s.threads != 3 || s.start != 9876 || s.rssPages != 512 {
		t.Fatalf("got %+v", s)
	}
}

func TestParseProcStatRejectsGarbage(t *testing.T) {
	if _, err := parseProcStat("42 nope"); err == nil {
		t.Fatal("want an error")
	}
}

func TestListProcessesReadsEveryField(t *testing.T) {
	root := t.TempDir()
	fakeProc(t, root, 812, statLine(812, "smbd", "S", 1, 0, 400, 100, 2, 5000, 1000),
		"Name:\tsmbd\nUid:\t1001\t1001\t1001\t1001\n", "/usr/sbin/smbd\x00--foreground\x00",
		"rchar: 1\nread_bytes: 4096\nwrite_bytes: 8192\n")
	fakeProc(t, root, 2, statLine(2, "kthreadd", "S", 0, pfKthread, 0, 0, 1, 1, 0), "Uid:\t0\t0\t0\t0\n", "", "")
	if err := os.WriteFile(filepath.Join(root, "uptime"), []byte("1.0 1.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pr := procReader{root: root, pageSize: 4096, self: 1, install: "/opt/hsi", user: func(uid string) string {
		if uid == "1001" {
			return "camille"
		}
		return "root"
	}}
	list := pr.list()
	if len(list) != 2 {
		t.Fatalf("want 2 processes, got %d", len(list))
	}
	var smbd *procInfo
	for i := range list {
		if list[i].Pid == 812 {
			smbd = &list[i]
		}
	}
	if smbd == nil {
		t.Fatal("smbd missing")
	}
	if smbd.Name != "smbd" || smbd.User != "camille" || smbd.Cmd != "/usr/sbin/smbd --foreground" || smbd.Ticks != 500 ||
		smbd.Rss != 1000*4096 || smbd.Start != "5000" || smbd.Read != 4096 || smbd.Write != 8192 || smbd.Threads != 2 || smbd.Protected {
		t.Fatalf("got %+v", *smbd)
	}
}

func TestProtectedProcesses(t *testing.T) {
	pr := procReader{self: 77, install: "/opt/hsi"}
	cases := []struct {
		name string
		p    procStat
		cmd  []string
		want bool
	}{
		{"init", procStat{pid: 1}, []string{"/sbin/init"}, true},
		{"kernel thread", procStat{pid: 30, flags: pfKthread}, nil, true},
		{"child of kthreadd", procStat{pid: 31, ppid: 2}, nil, true},
		{"the worker", procStat{pid: 77}, []string{"/usr/local/bin/hsi-worker"}, true},
		{"the backend", procStat{pid: 90}, []string{"/usr/bin/node", "/opt/hsi/current/backend/dist/index.js"}, true},
		{"nats", procStat{pid: 91, name: "nats-server"}, []string{"/usr/local/bin/nats-server"}, true},
		{"a user program", procStat{pid: 92, name: "rsync"}, []string{"rsync", "-a", "/srv"}, false},
		{"lookalike path", procStat{pid: 93, name: "cat"}, []string{"cat", "/opt/hsi-old/x"}, false},
	}
	for _, c := range cases {
		if got := pr.protected(c.p, c.cmd); got != c.want {
			t.Errorf("%s: protected = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestKillChecksTheProcessIsTheSameOne(t *testing.T) {
	root := t.TempDir()
	fakeProc(t, root, 500, statLine(500, "rsync", "R", 1, 0, 1, 1, 1, 7000, 10), "Uid:\t0\t0\t0\t0\n", "rsync\x00", "")
	fakeProc(t, root, 600, statLine(600, "nats-server", "S", 1, 0, 1, 1, 1, 7100, 10), "Uid:\t0\t0\t0\t0\n", "/usr/local/bin/nats-server\x00", "")
	var sent []string
	pr := procReader{root: root, self: 1, install: "/opt/hsi", signal: func(pid int, force bool) error {
		sent = append(sent, strconv.Itoa(pid)+":"+strconv.FormatBool(force))
		return nil
	}}
	if fe := pr.kill(500, "6999", false); fe == nil || fe.Code != "NOT_FOUND" {
		t.Fatalf("a reused pid must be refused, got %+v", fe)
	}
	if fe := pr.kill(501, "7000", false); fe == nil || fe.Code != "NOT_FOUND" {
		t.Fatalf("a gone process must be NOT_FOUND, got %+v", fe)
	}
	if fe := pr.kill(600, "7100", true); fe == nil || fe.Code != "PROTECTED" {
		t.Fatalf("nats must be protected, got %+v", fe)
	}
	if fe := pr.kill(500, "7000", true); fe != nil {
		t.Fatalf("kill: %+v", fe)
	}
	if len(sent) != 1 || sent[0] != "500:true" {
		t.Fatalf("signals sent: %v", sent)
	}
}
