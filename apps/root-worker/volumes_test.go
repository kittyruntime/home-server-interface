package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const confWithVolumes = `# /etc/fstab
UUID=root / ext4 defaults 0 1
# HSI-managed mount: /mnt/data
UUID=aaaa-1111	/mnt/data	ext4	defaults	0	2
UUID=admin /mnt/admin ext4 defaults 0 2
# HSI-managed mount: /mnt/data2
UUID=bbbb-2222	/mnt/data2	xfs	defaults,nofail	0	2
`

func TestHsiVolumesReadsMarkedEntriesOnly(t *testing.T) {
	v := hsiVolumes(confWithVolumes)
	if len(v) != 2 || v[0].MountPoint != "/mnt/data" || v[0].UUID != "aaaa-1111" || v[1].FSType != "xfs" {
		t.Fatalf("got %+v", v)
	}
}

func TestWithBootOptionsIsIdempotent(t *testing.T) {
	got := withBootOptions("defaults")
	if got != "defaults,nofail,x-systemd.device-timeout=10s" {
		t.Fatalf("got %q", got)
	}
	if withBootOptions(got) != got {
		t.Fatal("not idempotent")
	}
	if got := withBootOptions("defaults,x-systemd.device-timeout=30s"); got != "defaults,x-systemd.device-timeout=30s,nofail" {
		t.Fatalf("existing timeout must be kept, got %q", got)
	}
}

func TestEnsureBootOptionsTouchesMarkedEntriesOnly(t *testing.T) {
	out := ensureBootOptions(confWithVolumes)
	want := "UUID=aaaa-1111\t/mnt/data\text4\tdefaults,nofail,x-systemd.device-timeout=10s\t0\t2"
	if !strings.Contains(out, want) {
		t.Fatalf("marked entry not updated:\n%s", out)
	}
	if !strings.Contains(out, "UUID=admin /mnt/admin ext4 defaults 0 2") {
		t.Fatal("admin entry changed")
	}
	if ensureBootOptions(out) != out {
		t.Fatal("not idempotent")
	}
}

func TestVolumeOwnerLongestPrefix(t *testing.T) {
	v := []volumeEntry{{MountPoint: "/mnt/data"}, {MountPoint: "/mnt/data/sub"}, {MountPoint: "/mnt/data2"}}
	cases := map[string]string{
		"/mnt/data/x": "/mnt/data", "/mnt/data/sub/y": "/mnt/data/sub", "/mnt/data2/z": "/mnt/data2",
		"/mnt/data": "/mnt/data", "/mnt/dataX": "",
	}
	for p, want := range cases {
		got, ok := volumeOwner(v, p)
		if (want == "" && ok) || (want != "" && got.MountPoint != want) {
			t.Errorf("%s: got %q ok=%v, want %q", p, got.MountPoint, ok, want)
		}
	}
}

func TestVolumeState(t *testing.T) {
	cases := []struct{ out, want string }{
		{"", "missing"},
		{`UUID="aaaa-1111" OPTIONS="rw,relatime"`, "ok"},
		{`UUID="aaaa-1111" OPTIONS="ro,relatime"`, "readonly"},
		{`UUID="other" OPTIONS="rw"`, "wrong"},
	}
	for _, c := range cases {
		if got := volumeState("aaaa-1111", c.out); got != c.want {
			t.Errorf("%q: got %s want %s", c.out, got, c.want)
		}
	}
}

func TestDirHasEntries(t *testing.T) {
	d := t.TempDir()
	if dirHasEntries(d) {
		t.Fatal("empty dir reported as non-empty")
	}
	if err := os.WriteFile(filepath.Join(d, "x"), nil, 0644); err != nil {
		t.Fatal(err)
	}
	if !dirHasEntries(d) {
		t.Fatal("stray file not reported")
	}
}
