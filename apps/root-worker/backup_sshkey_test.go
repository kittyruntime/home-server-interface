package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const evilKey = "/x -oProxyCommand=sh -c id"

func TestValidSSHKeyPath(t *testing.T) {
	for _, ok := range []string{"/etc/hsi/backup/k", "/root/.ssh/id_ed25519", "/a/b-c/d.e"} {
		if err := validSSHKeyPath(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{evilKey, "rel/k", "/a/../b", "/a/-x/k", "/a b", "/a\nb", "/", ""} {
		if validSSHKeyPath(bad) == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestSyncPlanRejectsEvilKeyPath(t *testing.T) {
	c := backupConfig{Plans: []backupPlanCfg{{ID: planA, Name: "S", Type: "sync", Enabled: true,
		Schedule: backupSchedule{Every: "manual"},
		Sync: &syncOptions{Direction: "push", Source: "/srv/a", Destination: "/srv/b", RemoteHost: "h", RemoteUser: "u",
			RemotePort: 22, SSHKeyPath: evilKey}}}}
	if c.validate() == nil {
		t.Fatal("validate accepted the key path")
	}
}

func TestRepositorySaveRefusesEvilKeyPath(t *testing.T) {
	useUnits(t)
	repo := repositoryCfg{ID: repoA, Name: "S", Type: "sftp", Host: "h", User: "u", Port: 22, Path: "/r", Check: checkSchedule{Every: "off"}}
	if validateRepoSecrets(repo, repoSecrets{Password: "p", SSHKeyPath: evilKey}) == nil {
		t.Fatal("validateRepoSecrets accepted it")
	}
	_, fe := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": repo, "secrets": map[string]any{"password": "p", "sshKeyPath": evilKey}}))
	if fe == nil {
		t.Fatal("save accepted it")
	}
}

func TestBuildersRefuseEvilKeyPath(t *testing.T) {
	r := repositoryCfg{Type: "sftp"}
	if _, err := resticGlobalArgs(r, repoSecrets{SSHKeyPath: evilKey}); err == nil {
		t.Fatal("restic args built")
	}
	if _, err := runRsync(taskMsg{Source: "/srv/a", Destination: "/srv/b", Direction: "push", RemoteHost: "h", RemoteUser: "u",
		RemotePort: 22, SSHKeyPath: evilKey}); err == nil {
		t.Fatal("rsync ran")
	}
	if got := rsyncShell(evilKey, 22); got != "" {
		t.Fatalf("rsh built: %q", got)
	}
}

func TestRestoreRefusesEvilSecretsAndWritesNothing(t *testing.T) {
	useUnits(t)
	cfg := sampleConfig()
	cfg.Repositories[0] = repositoryCfg{ID: repoA, Name: "S", Type: "sftp", Host: "h", User: "u", Port: 22, Path: "/r", Check: checkSchedule{Every: "off"}}
	dir := filepath.Join(t.TempDir(), "x")
	_ = os.MkdirAll(filepath.Join(dir, "system", "backup", "secrets"), 0o755)
	raw, _ := json.Marshal(cfg)
	_ = os.WriteFile(filepath.Join(dir, "system", "backup", "backup.json"), raw, 0o644)
	sec, _ := json.Marshal(repoSecrets{Password: "p", SSHKeyPath: evilKey})
	_ = os.WriteFile(filepath.Join(dir, "system", "backup", "secrets", repoA+".json"), sec, 0o600)
	if err := restoreBackupConfig(dir, time.Now().Format("20060102")); err == nil {
		t.Fatal("restored")
	}
	if fileExists(backupConfigPath()) || fileExists(filepath.Join(backupSecretsDir(), repoA+".json")) {
		t.Fatal("something was written")
	}
}
