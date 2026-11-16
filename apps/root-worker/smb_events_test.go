package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureEvents(t *testing.T) []smbEvent {
	t.Helper()
	f, err := os.Open("testdata/smbd-audit.log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	return parseSmbLog(f)
}

func TestParseSmbLogEvents(t *testing.T) {
	got := fixtureEvents(t)
	want := []smbEvent{
		{Kind: "auth", Result: "ok", User: "fxa", IP: "192.168.1.48", Machine: "HSI"},
		{Kind: "connect", Result: "ok", User: "fxa", IP: "192.168.1.48", Machine: "hsi", Share: "Films"},
		{Kind: "disconnect", Result: "ok", User: "fxa", IP: "192.168.1.48", Machine: "hsi", Share: "Films"},
		{Kind: "auth", Result: "refused", Reason: "wrong_password", User: "fxa", IP: "192.168.1.48", Machine: "HSI"},
		{Kind: "auth", Result: "refused", Reason: "unknown_user", User: "ghost", IP: "192.168.1.48", Machine: "HSI"},
		{Kind: "auth", Result: "ok", User: "fxb", IP: "192.168.1.48", Machine: "HSI"},
		{Kind: "connect", Result: "refused", Reason: "no_access", User: "fxb", IP: "192.168.1.48", Share: "Films"},
		{Kind: "connect", Result: "refused", Reason: "blocked", IP: "10.42.0.4"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d events, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		g := got[i]
		if g.At.IsZero() {
			t.Errorf("event %d has no time", i)
		}
		g.At = want[i].At
		if g != want[i] {
			t.Errorf("event %d:\n got %+v\nwant %+v", i, g, want[i])
		}
	}
}

func TestParseSmbLogIgnoresOtherLines(t *testing.T) {
	in := "[2026/11/16 15:17:39.603782,  0] source3/smbd/server.c:1971(main)\n" +
		"  smbd version 4.22.11 started.\n" +
		`  {"timestamp": "2026-11-16T15:18:04.364341+0100", "type": "Authentication", "Authenti` + "\n" +
		"  ||||\n"
	if got := parseSmbLog(strings.NewReader(in)); len(got) != 0 {
		t.Fatalf("got %+v, want nothing", got)
	}
}

func TestParseSmbLogIPv6(t *testing.T) {
	in := `  {"timestamp": "2026-11-16T15:18:04.364341+0100", "type": "Authentication", "Authentication": {"status": "NT_STATUS_WRONG_PASSWORD", "remoteAddress": "ipv6:[fe80::1]:51000", "clientAccount": "a", "workstation": "W"}}` + "\n"
	got := parseSmbLog(strings.NewReader(in))
	if len(got) != 1 || got[0].IP != "fe80::1" {
		t.Fatalf("got %+v", got)
	}
}

func copyFixture(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("testdata/smbd-audit.log")
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "smbd.log")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const twoMoreLines = "[2026/11/16 15:20:00.000000,  1] source3/modules/vfs_full_audit.c:637(do_log)\n" +
	"  fxa|192.168.1.48|hsi|Films|connect|ok|Films\n" +
	"[2026/11/16 15:20:01.000000,  1] source3/modules/vfs_full_audit.c:637(do_log)\n" +
	"  fxa|192.168.1.48|hsi|Films|disconnect|ok|Films\n"

func appendTo(t *testing.T, p, s string) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func TestEventsCursorResumes(t *testing.T) {
	p := copyFixture(t)
	evs, c, err := readSmbEvents(p, smbCursor{}, 1<<20)
	if err != nil || len(evs) != 8 {
		t.Fatalf("first read: %d events, %v", len(evs), err)
	}
	appendTo(t, p, twoMoreLines)
	evs, _, err = readSmbEvents(p, c, 1<<20)
	if err != nil || len(evs) != 2 || evs[0].Kind != "connect" || evs[1].Kind != "disconnect" {
		t.Fatalf("second read: %+v, %v", evs, err)
	}
}

func TestEventsCursorSurvivesRotation(t *testing.T) {
	p := copyFixture(t)
	_, c, _ := readSmbEvents(p, smbCursor{}, 1<<20)
	// smbd renames the full log to .old and starts a new file.
	if err := os.Rename(p, p+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(twoMoreLines), 0o644); err != nil {
		t.Fatal(err)
	}
	evs, _, err := readSmbEvents(p, c, 1<<20)
	if err != nil || len(evs) != 2 {
		t.Fatalf("after rotation: %+v, %v", evs, err)
	}
	// Truncated in place below the cursor: start over too.
	_, c, _ = readSmbEvents(p, smbCursor{}, 1<<20)
	if err := os.WriteFile(p, []byte(twoMoreLines[:len(twoMoreLines)/2+20]), 0o644); err != nil {
		t.Fatal(err)
	}
	c.Offset += 1000
	if _, c2, err := readSmbEvents(p, c, 1<<20); err != nil || c2.Offset > int64(len(twoMoreLines)) {
		t.Fatalf("after truncation: cursor %+v, %v", c2, err)
	}
}

func TestEventsMaxBytesNeverSplitsALine(t *testing.T) {
	p := copyFixture(t)
	var all []smbEvent
	c := smbCursor{}
	for i := 0; i < 200; i++ {
		evs, next, err := readSmbEvents(p, c, 700)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, evs...)
		if next == c {
			break
		}
		c = next
	}
	if len(all) != 8 {
		t.Fatalf("small reads found %d events, want 8", len(all))
	}
}

func TestEventsMissingFileIsUnavailable(t *testing.T) {
	_, _, err := readSmbEvents(filepath.Join(t.TempDir(), "none.log"), smbCursor{}, 1<<20)
	if !os.IsNotExist(err) {
		t.Fatalf("got %v, want a not-exist error", err)
	}
}
