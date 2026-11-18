package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSftpDropInConfinesTheGroup(t *testing.T) {
	for _, l := range []string{"Match Group hsi-sftp", "ChrootDirectory /var/lib/hsi-sftp/%u", "ForceCommand internal-sftp -u 0002",
		"AllowTcpForwarding no", "X11Forwarding no", "PermitTTY no", "PasswordAuthentication yes"} {
		if !strings.Contains(sftpDropIn, "\n"+l+"\n") && !strings.Contains(sftpDropIn, "    "+l+"\n") {
			t.Errorf("missing %q in\n%s", l, sftpDropIn)
		}
	}
	// Whatever follows in the main config must not stay inside the Match.
	if !strings.HasSuffix(sftpDropIn, "Match all\n") {
		t.Fatal("the drop-in must end the Match block")
	}
}

func TestSshdReadsDropIns(t *testing.T) {
	if !sshdReadsDropIns("# x\nInclude /etc/ssh/sshd_config.d/*.conf\nPort 22\n") {
		t.Fatal("Debian's Include not seen")
	}
	if !sshdReadsDropIns("  include sshd_config.d/*.conf\n") {
		t.Fatal("relative, lower-case Include not seen")
	}
	if sshdReadsDropIns("# Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n") {
		t.Fatal("a commented Include counted")
	}
}

const passwdFixture = `root:x:0:0:root:/root:/bin/bash
theophile:x:1000:1000::/home/theophile:/bin/bash
alice:x:1001:1001::/home/alice:/usr/sbin/nologin
bob:x:1002:1002::/home/bob:/bin/false
carol:x:1003:1003::/home/carol:/sbin/nologin
`

func TestSftpAccountsAreHsiOnlyAccounts(t *testing.T) {
	ok, left := sftpAccounts(passwdFixture, []string{"theophile", "alice", "bob", "carol", "root", "ghost"})
	if !reflect.DeepEqual(ok, []string{"alice", "bob", "carol"}) {
		t.Fatalf("allowed %v", ok)
	}
	if !reflect.DeepEqual(left, []string{"ghost", "root", "theophile"}) {
		t.Fatalf("left out %v", left)
	}
}

const mountinfoFixture = `22 1 253:0 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw
40 22 8:17 / /srv/media rw,relatime shared:20 - ext4 /dev/sdb1 rw
41 22 8:33 / /srv/My\040Disk rw,relatime shared:21 - ext4 /dev/sdc1 rw
50 22 8:17 /films /var/lib/hsi-sftp/alice/Films rw,relatime shared:20 - ext4 /dev/sdb1 rw
51 22 8:17 /music /var/lib/hsi-sftp/alice/Music ro,relatime shared:20 - ext4 /dev/sdb1 rw
52 22 253:0 /srv/old /var/lib/hsi-sftp/bob/Old rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw
`

func TestParseMountinfoUnescapes(t *testing.T) {
	m := parseMountinfo(mountinfoFixture)
	if m[2].MountPoint != "/srv/My Disk" || m[2].MajMin != "8:33" || m[4].Root != "/music" || !m[4].ReadOnly || m[3].ReadOnly {
		t.Fatalf("parsed %+v", m)
	}
}

func TestSftpMountPlan(t *testing.T) {
	desired := []sftpMount{
		{Dst: "/var/lib/hsi-sftp/alice/Films", Src: "/srv/media/films"},            // in place
		{Dst: "/var/lib/hsi-sftp/alice/Music", Src: "/srv/media/music"},            // ro -> rw
		{Dst: "/var/lib/hsi-sftp/alice/Docs", Src: "/srv/My Disk/docs", RO: true},  // new
		{Dst: "/var/lib/hsi-sftp/bob/Old", Src: "/srv/media/elsewhere", RO: false}, // points elsewhere now
	}
	unmount, mount, remount := sftpMountPlan(desired, parseMountinfo(mountinfoFixture))
	if !reflect.DeepEqual(unmount, []string{"/var/lib/hsi-sftp/bob/Old"}) {
		t.Fatalf("unmount %v", unmount)
	}
	if !reflect.DeepEqual(mount, []sftpMount{desired[2], desired[3]}) {
		t.Fatalf("mount %+v", mount)
	}
	if !reflect.DeepEqual(remount, []sftpMount{desired[1]}) {
		t.Fatalf("remount %+v", remount)
	}
}

func TestSftpMountPlanRemovesWhatIsNoLongerShared(t *testing.T) {
	unmount, mount, remount := sftpMountPlan(nil, parseMountinfo(mountinfoFixture))
	want := []string{"/var/lib/hsi-sftp/bob/Old", "/var/lib/hsi-sftp/alice/Music", "/var/lib/hsi-sftp/alice/Films"}
	if !reflect.DeepEqual(unmount, want) || len(mount) != 0 || len(remount) != 0 {
		t.Fatalf("unmount %v mount %v remount %v", unmount, mount, remount)
	}
}

func TestSftpBindsOnAVolume(t *testing.T) {
	got := sftpBindsOn(parseMountinfo(mountinfoFixture), "/srv/media")
	if !reflect.DeepEqual(got, []string{"/var/lib/hsi-sftp/alice/Music", "/var/lib/hsi-sftp/alice/Films"}) {
		t.Fatalf("got %v", got)
	}
	if got := sftpBindsOn(parseMountinfo(mountinfoFixture), "/srv/none"); len(got) != 0 {
		t.Fatalf("nothing mounted there: %v", got)
	}
}

func TestSftpViewPathsAreSafe(t *testing.T) {
	if _, err := sftpViewPath("alice", "Films"); err != nil {
		t.Fatal(err)
	}
	for _, c := range [][2]string{{"../etc", "Films"}, {"alice", "../x"}, {"alice", ".."}, {"root", "Films"}, {"alice", "a/b"}} {
		if _, err := sftpViewPath(c[0], c[1]); err == nil {
			t.Errorf("%v accepted", c)
		}
	}
}

func TestSshdPort(t *testing.T) {
	if p := sshdPort("port 2222\nport 22\naddressfamily any\n"); p != 2222 {
		t.Fatalf("got %d", p)
	}
	if p := sshdPort("addressfamily any\n"); p != 22 {
		t.Fatalf("default: got %d", p)
	}
}

func TestSftpSessions(t *testing.T) {
	ps := "root     sshd-session: alice [priv]\nalice    sshd-session: alice@internal-sftp\nbob      sshd: bob@internal-sftp\nalice    sshd-session: alice@internal-sftp\ntheo     sshd-session: theo@pts/0\n"
	if got := sftpSessions(ps); !reflect.DeepEqual(got, []string{"alice", "bob"}) {
		t.Fatalf("got %v", got)
	}
}

func TestSafeShareFolder(t *testing.T) {
	root := t.TempDir() // owned by the test user, so only the owner check is stubbed
	share := filepath.Join(root, "media", "films")
	if err := os.MkdirAll(share, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(root, 0o755)
	_ = os.Chmod(filepath.Join(root, "media"), 0o755) // whatever the umask made them
	// The checks stop at root: the system's /tmp above it is sticky and world-writable.
	safeShareFolder := func(p string, owned func(os.FileInfo) bool) error { return safeShareFolderUpTo(p, owned, root) }
	ok := func(fi os.FileInfo) bool { return true }
	if err := safeShareFolder(share, ok); err != nil {
		t.Fatalf("a plain folder refused: %v", err)
	}
	// A folder someone else can write: whoever can write it can swap the share.
	_ = os.Chmod(filepath.Join(root, "media"), 0o775)
	if err := safeShareFolder(share, ok); err == nil {
		t.Fatal("a group-writable parent accepted")
	}
	_ = os.Chmod(filepath.Join(root, "media"), 0o755)
	link := filepath.Join(root, "media", "link")
	_ = os.Symlink(share, link)
	if err := safeShareFolder(link, ok); err == nil {
		t.Fatal("a symbolic link accepted")
	}
	if err := safeShareFolder(share, func(os.FileInfo) bool { return false }); err == nil {
		t.Fatal("a parent not owned by root accepted")
	}
	if err := safeShareFolder("relative/x", ok); err == nil {
		t.Fatal("a relative path accepted")
	}
	// Under a sticky world-writable folder (like /tmp) the owner of the
	// share's folder could still rename it: refused.
	_ = os.Chmod(filepath.Join(root, "media"), 0o777|os.ModeSticky)
	if err := safeShareFolder(share, ok); err == nil {
		t.Fatal("a sticky world-writable parent accepted")
	}
}
