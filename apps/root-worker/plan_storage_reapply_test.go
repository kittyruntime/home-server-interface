package main

import (
	"os"
	"strings"
	"testing"
)

const reapplyFstab = "UUID=root / ext4 defaults 0 1\n# HSI-managed mount: /srv/data\nUUID=fs-1\t/srv/data\text4\tdefaults,nofail\t0\t2\n"
const reapplyMdadm = "# HSI-managed array: md0\nARRAY /dev/md0 metadata=1.2 UUID=U\n"

// stubReapply saves driftDesc as the description and serves live (edited
// from driftLive) as the server's state.
func stubReapply(t *testing.T, fstab, mdadm string, edit func(*liveVolume)) {
	t.Helper()
	stubDescriptionsDir(t)
	if _, err := saveDescription(driftDesc()); err != nil {
		t.Fatal(err)
	}
	stubConfigFiles(t, fstab, mdadm)
	pc, pn, pl, pe, pb, pk := collectLiveFn, hostMdNames, hostLookPath, hostExists, hostMdBrief, hostBlkid
	t.Cleanup(func() {
		collectLiveFn, hostMdNames, hostLookPath, hostExists, hostMdBrief, hostBlkid = pc, pn, pl, pe, pb, pk
	})
	l := driftLive()
	edit(&l)
	collectLiveFn = func(storageDescription) liveVolume { return l }
	hostMdNames = func() []string { return nil }
	hostLookPath = func(string) bool { return true }
	hostExists = func(string) bool { return true }
	hostMdBrief = func(string) (string, error) { return "ARRAY /dev/md127 metadata=1.2 UUID=U", nil }
	hostBlkid = func(string, string) string { return "btrfs" }
}

func reapply(t *testing.T, in string) (*opPlan, *fsError) {
	t.Helper()
	return build(t, planStorageReapply, in)
}

func stepTargets(p *opPlan) string {
	var out []string
	for _, s := range p.Steps {
		out = append(out, s.Kind+":"+s.Target)
	}
	return strings.Join(out, " ")
}

func TestReapplyRestoresFstab(t *testing.T) {
	stubReapply(t, "UUID=root / ext4 defaults 0 1\n", reapplyMdadm, func(l *liveVolume) { l.FstabPresent = false })
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if stepTargets(p) != "update:"+fstabPath || !strings.Contains(p.Steps[0].Diff, "+UUID=fs-1\t/srv/data\text4\tdefaults,nofail\t0\t2") {
		t.Fatalf("fstab only: %s\n%s", stepTargets(p), p.Steps[0].Diff)
	}
}

func TestReapplyRestoresMdadmConfAndInitramfs(t *testing.T) {
	stubReapply(t, reapplyFstab, "", func(l *liveVolume) { l.MdadmConfHasArray = false })
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if stepTargets(p) != "update:"+mdadmConfPath+" run:initramfs" || !strings.Contains(p.Steps[0].Diff, "+ARRAY /dev/md127 metadata=1.2 UUID=U") {
		t.Fatalf("mdadm.conf: %s\n%s", stepTargets(p), p.Steps[0].Diff)
	}
}

func TestReapplyAssembleUsesUUID(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) {
		l.ArrayDev, l.ArrayLevel, l.ArrayMembers, l.VGActive, l.MountedOn, l.FSDevices = "", "", nil, false, "", nil
	})
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	got := argvs(p)
	want := "mdadm --assemble /dev/md0 --uuid=U /dev/disk/by-id/ata-A /dev/disk/by-id/ata-B /dev/disk/by-id/ata-C"
	if len(got) == 0 || strings.Join(got[0], " ") != want {
		t.Fatalf("assemble: %v", got)
	}
}

func TestReapplyActivatesVGAndMounts(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.VGActive, l.MountedOn = false, "" })
	p, fe := reapply(t, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	var cmds []string
	for _, a := range argvs(p) {
		cmds = append(cmds, strings.Join(a, " "))
	}
	if strings.Join(cmds, " | ") != "vgchange -ay data | mount -o defaults,nofail UUID=fs-1 /srv/data" {
		t.Fatalf("commands: %v", cmds)
	}
}

func TestReapplyDegradedNeedsAck(t *testing.T) {
	edit := func(l *liveVolume) {
		l.ArrayDev, l.ArrayLevel, l.ArrayMembers, l.VGActive, l.MountedOn, l.FSDevices = "", "", nil, false, "", nil
		l.Connected["B"] = false
	}
	stubReapply(t, reapplyFstab, reapplyMdadm, edit)
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || fe.Code != "EDEGRADED" || !strings.Contains(fe.Message, "without B") {
		t.Fatalf("needs the acknowledge: %+v", fe)
	}
	p, fe := reapply(t, `{"mountPoint":"/srv/data","degraded":true}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if a := strings.Join(argvs(p)[0], " "); !strings.Contains(a, "--run") || strings.Contains(a, "ata-B") {
		t.Fatalf("degraded assemble: %s", a)
	}
}

func TestReapplyTooFewMembersRefused(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) {
		l.ArrayDev, l.ArrayMembers, l.MountedOn, l.FSDevices = "", nil, "", nil
		l.Connected["B"], l.Connected["C"] = false, false
	})
	if _, fe := reapply(t, `{"mountPoint":"/srv/data","degraded":true}`); fe == nil || fe.Code != "EMISSING" {
		t.Fatalf("raid5 needs 2 of 3: %+v", fe)
	}
}

func TestReapplyRefusesMissingOrClonedFS(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.MountedOn, l.FSDevices = "", nil })
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || fe.Code != "ENOFS" {
		t.Fatalf("no filesystem: %+v", fe)
	}
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.MountedOn, l.FSDevices = "", []string{"/dev/sdx", "/dev/sdy"} })
	hostBlkid = func(string, string) string { return "ext4" }
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || !strings.Contains(fe.Message, "clone") {
		t.Fatalf("clone: %+v", fe)
	}
}

func TestReapplyBusyMountPoint(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.MountedOn, l.MountPointUUID = "", "fs-9" })
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || fe.Code != "EBUSY" {
		t.Fatalf("another filesystem there: %+v", fe)
	}
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.MountedOn = "/mnt/x" })
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || fe.Code != "EBUSY" {
		t.Fatalf("mounted elsewhere: %+v", fe)
	}
}

func TestReapplyNothingToDo(t *testing.T) {
	stubReapply(t, reapplyFstab, reapplyMdadm, func(*liveVolume) {})
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || fe.Code != "ENOOP" {
		t.Fatalf("clean: %+v", fe)
	}
	stubReapply(t, reapplyFstab, reapplyMdadm, func(l *liveVolume) { l.ArrayMembers["D"] = "active" })
	if _, fe := reapply(t, `{"mountPoint":"/srv/data"}`); fe == nil || fe.Code != "ENOOP" || !strings.Contains(fe.Message, "Accept") {
		t.Fatalf("members are not reapplied: %+v", fe)
	}
	stubReapply(t, reapplyFstab, reapplyMdadm, func(*liveVolume) {})
	if _, fe := reapply(t, `{"mountPoint":"/srv/none"}`); fe == nil || fe.Code != "ENOENT" {
		t.Fatalf("no description: %+v", fe)
	}
}

func TestReapplyNeverDestructive(t *testing.T) {
	stubReapply(t, "", "", func(l *liveVolume) {
		l.ArrayDev, l.ArrayLevel, l.ArrayMembers, l.VGActive, l.MountedOn, l.FSDevices = "", "", nil, false, "", nil
		l.FstabPresent, l.MdadmConfHasArray = false, false
		l.Connected["C"] = false
	})
	p, fe := reapply(t, `{"mountPoint":"/srv/data","degraded":true}`)
	if fe != nil {
		t.Fatal(fe)
	}
	for _, s := range p.Steps {
		joined := strings.Join(s.Command, " ")
		if s.Destructive || strings.Contains(joined, "mkfs") || strings.Contains(joined, "wipefs") ||
			strings.Contains(joined, "--create") || strings.Contains(joined, "--add") || strings.Contains(joined, "--zero-superblock") {
			t.Fatalf("destructive step: %+v", s)
		}
	}
	if len(p.Steps) < 5 {
		t.Fatalf("every repair step: %s", stepTargets(p))
	}
}

func TestAcceptShowsDiffAndWrites(t *testing.T) {
	stubDescriptionsDir(t)
	path, _ := saveDescription(driftDesc())
	described := stubDescribeFn(t, nil) // describes "/srv/data" with options "defaults"
	p, fe := build(t, planStorageAccept, `{"mountPoint":"/srv/data"}`)
	if fe != nil {
		t.Fatal(fe)
	}
	if len(p.Steps) != 1 || p.Steps[0].Target != path || !strings.Contains(p.Steps[0].Diff, "+  options: defaults") {
		t.Fatalf("diff: %+v", p.Steps)
	}
	if _, err := p.Steps[0].run(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "options: defaults\n") || len(*described) == 0 {
		t.Fatalf("written: %s", raw)
	}
}

func TestAcceptNeedsMounted(t *testing.T) {
	stubDescriptionsDir(t)
	_, _ = saveDescription(driftDesc())
	stubDescribeFn(t, &fsError{Code: "ENOTMOUNTED", Message: "/srv/data is not mounted"})
	if _, fe := build(t, planStorageAccept, `{"mountPoint":"/srv/data"}`); fe == nil || !strings.Contains(fe.Message, "Mount /srv/data first, or Reapply") {
		t.Fatalf("unmounted: %+v", fe)
	}
}
