package main

import (
	"errors"
	"testing"
)

func TestCmdErrMessage(t *testing.T) {
	if got := cmdErrMessage([]byte("  mdadm: device busy \n"), errors.New("exit status 1")); got != "mdadm: device busy" {
		t.Errorf("with output: got %q", got)
	}
	if got := cmdErrMessage(nil, errors.New(`exec: "mdadm": executable file not found in $PATH`)); got != `exec: "mdadm": executable file not found in $PATH` {
		t.Errorf("without output: got %q", got)
	}
	if got := cmdErrMessage(nil, nil); got == "" {
		t.Error("must never return an empty message")
	}
}

const adminConf = `# mdadm.conf
HOMEHOST <system>
MAILADDR admin@example.com
ARRAY /dev/md/data metadata=1.2 UUID=11111111:11111111:11111111:11111111
`

func TestUpsertArrayLineKeepsAdminContent(t *testing.T) {
	line := "ARRAY /dev/md0 metadata=1.2 UUID=22222222:22222222:22222222:22222222"
	got := upsertArrayLine(adminConf, "md0", line)
	want := adminConf + "# HSI-managed array: md0\n" + line + "\n"
	if got != want {
		t.Fatalf("upsertArrayLine() =\n%s\nwant\n%s", got, want)
	}
	// Idempotent, and an updated line replaces the previous HSI entry.
	if again := upsertArrayLine(got, "md0", line); again != want {
		t.Fatalf("second upsert changed the file:\n%s", again)
	}
	updated := "ARRAY /dev/md0 metadata=1.2 UUID=33333333:33333333:33333333:33333333"
	if got2 := upsertArrayLine(got, "md0", updated); got2 != adminConf+"# HSI-managed array: md0\n"+updated+"\n" {
		t.Fatalf("update did not replace the HSI entry:\n%s", got2)
	}
}

func TestUpsertArrayLineReplacesUnmarkedLineForSameArray(t *testing.T) {
	// Files overwritten by earlier HSI versions hold unmarked ARRAY lines.
	conf := "ARRAY /dev/md0 metadata=1.2 UUID=22222222:22222222:22222222:22222222\n"
	line := "ARRAY /dev/md0 metadata=1.2 UUID=22222222:22222222:22222222:22222222"
	want := "# HSI-managed array: md0\n" + line + "\n"
	if got := upsertArrayLine(conf, "md0", line); got != want {
		t.Fatalf("upsertArrayLine() =\n%s\nwant\n%s", got, want)
	}
}

func TestRemoveArrayLineOnlyTouchesHSIEntry(t *testing.T) {
	line := "ARRAY /dev/md0 metadata=1.2 UUID=22222222:22222222:22222222:22222222"
	conf := upsertArrayLine(adminConf, "md0", line)
	if got := removeArrayLine(conf, "md0"); got != adminConf {
		t.Fatalf("removeArrayLine() =\n%s\nwant\n%s", got, adminConf)
	}
	if got := removeArrayLine(adminConf, "md0"); got != adminConf {
		t.Fatalf("removeArrayLine() must not touch admin lines:\n%s", got)
	}
}

func TestBriefArrayLine(t *testing.T) {
	out := "ARRAY /dev/md0 metadata=1.2 UUID=22222222:22222222:22222222:22222222\n   devices=/dev/vdb,/dev/vdc\n"
	if got := briefArrayLine(out); got != "ARRAY /dev/md0 metadata=1.2 UUID=22222222:22222222:22222222:22222222" {
		t.Errorf("briefArrayLine() = %q", got)
	}
	if got := briefArrayLine("mdadm: cannot open /dev/md9"); got != "" {
		t.Errorf("briefArrayLine() = %q, want empty", got)
	}
}
