package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testRepoPath is the folder of the sample local repository: a real one once
// useBackupDirs has run, since every run checks it.
var testRepoPath = "/srv/usb/restic"

func useBackupDirs(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HSI_BACKUP_CONFIG", filepath.Join(root, "backup.json"))
	t.Setenv("HSI_BACKUP_SECRETS", filepath.Join(root, "secrets"))
	t.Setenv("HSI_BACKUP_STATE", filepath.Join(root, "state"))
	t.Setenv("HSI_BACKUP_LOCKS", filepath.Join(root, "locks"))
	prevRepo := testRepoPath
	testRepoPath = filepath.Join(root, "repo")
	if err := os.Mkdir(testRepoPath, 0o700); err != nil {
		t.Fatal(err)
	}
	// Sources under /srv/data are on a data volume.
	prevMount := volumeMountFor
	volumeMountFor = func(p string) string {
		if p == "/srv/data" || strings.HasPrefix(p, "/srv/data/") {
			return "/srv/data"
		}
		return ""
	}
	t.Cleanup(func() { testRepoPath, volumeMountFor = prevRepo, prevMount; resetInterrupt() })
	return root
}

const planA = "11111111-1111-4111-8111-111111111111"
const repoA = "22222222-2222-4222-8222-222222222222"

func sampleConfig() backupConfig {
	return backupConfig{
		Repositories: []repositoryCfg{{ID: repoA, Name: "USB", Type: "local", Path: testRepoPath,
			Check: checkSchedule{Every: "weekly", Hour: 4, Subset: "5%"}}},
		Plans: []backupPlanCfg{{ID: planA, Name: "Photos", Type: "versions", Enabled: true,
			Schedule: backupSchedule{Every: "daily", Hour: 2, Minute: 30},
			Versions: &versionsOptions{Sources: []string{"/srv/data/photos"}, Repository: repoA,
				Retention: retentionPolicy{KeepDaily: 7, KeepWeekly: 4}}}},
	}
}

func TestBackupConfigMissingFileIsEmpty(t *testing.T) {
	useBackupDirs(t)
	c, exists, err := loadBackupConfig()
	if err != nil || exists || len(c.Plans) != 0 {
		t.Fatalf("got %+v %v %v", c, exists, err)
	}
}

func TestBackupConfigRoundTrip(t *testing.T) {
	useBackupDirs(t)
	if err := saveBackupConfig(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	c, exists, err := loadBackupConfig()
	if err != nil || !exists || c.Plans[0].Versions.Retention.KeepWeekly != 4 {
		t.Fatalf("got %+v %v %v", c, exists, err)
	}
	info, _ := os.Stat(backupConfigPath())
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", info.Mode())
	}
}

func TestBackupConfigValidate(t *testing.T) {
	cases := map[string]func(*backupConfig){
		"bad id":             func(c *backupConfig) { c.Plans[0].ID = "../x" },
		"unknown repository": func(c *backupConfig) { c.Plans[0].Versions.Repository = planA },
		"relative source":    func(c *backupConfig) { c.Plans[0].Versions.Sources = []string{"photos"} },
		"root source":        func(c *backupConfig) { c.Plans[0].Versions.Sources = []string{"/"} },
		"no retention":       func(c *backupConfig) { c.Plans[0].Versions.Retention = retentionPolicy{} },
		"bad schedule":       func(c *backupConfig) { c.Plans[0].Schedule.Every = "yearly" },
		"bad hour":           func(c *backupConfig) { c.Plans[0].Schedule.Hour = 24 },
		"bad repo type":      func(c *backupConfig) { c.Repositories[0].Type = "ftp" },
		"local relative":     func(c *backupConfig) { c.Repositories[0].Path = "restic" },
		"sftp no host":       func(c *backupConfig) { c.Repositories[0].Type = "sftp"; c.Repositories[0].User = "nas" },
		"s3 no bucket":       func(c *backupConfig) { c.Repositories[0].Type = "s3"; c.Repositories[0].Endpoint = "s3.example.com" },
		"rest not http":      func(c *backupConfig) { c.Repositories[0].Type = "rest"; c.Repositories[0].URL = "ftp://x" },
		"bad subset":         func(c *backupConfig) { c.Repositories[0].Check.Subset = "200%" },
		"duplicate plan id":  func(c *backupConfig) { c.Plans = append(c.Plans, c.Plans[0]) },
		"bad app name":       func(c *backupConfig) { c.Plans[0].Versions.StopApps = []string{"../etc"} },
		"sync without opts":  func(c *backupConfig) { c.Plans[0].Type = "sync" },
	}
	if err := sampleConfig().validate(); err != nil {
		t.Fatalf("sample invalid: %v", err)
	}
	for name, mutate := range cases {
		c := sampleConfig()
		mutate(&c)
		if c.validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestOnCalendar(t *testing.T) {
	cases := []struct {
		s    backupSchedule
		want string
	}{
		{backupSchedule{Every: "manual"}, ""},
		{backupSchedule{Every: "hourly", Minute: 5}, "*-*-* *:05:00"},
		{backupSchedule{Every: "daily", Hour: 2, Minute: 30}, "*-*-* 02:30:00"},
		{backupSchedule{Every: "weekly", Weekday: 0, Hour: 3}, "Sun *-*-* 03:00:00"},
		{backupSchedule{Every: "weekly", Weekday: 6, Hour: 23, Minute: 59}, "Sat *-*-* 23:59:00"},
	}
	for _, c := range cases {
		if got := onCalendar(c.s); got != c.want {
			t.Errorf("%+v: %q, want %q", c.s, got, c.want)
		}
	}
	if got := checkOnCalendar(checkSchedule{Every: "monthly", Day: 1, Hour: 4}); got != "*-*-01 04:00:00" {
		t.Errorf("monthly: %q", got)
	}
	if got := checkOnCalendar(checkSchedule{Every: "off"}); got != "" {
		t.Errorf("off: %q", got)
	}
}

func TestRepoSecretsFileMode(t *testing.T) {
	useBackupDirs(t)
	if err := writeRepoSecrets(repoA, repoSecrets{Password: "pw", SecretAccessKey: "s"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(backupSecretsDir(), repoA+".json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", info, err)
	}
	s, err := readRepoSecrets(repoA)
	if err != nil || s.Password != "pw" {
		t.Fatalf("%+v %v", s, err)
	}
	raw, _ := os.ReadFile(backupConfigPath())
	if strings.Contains(string(raw), "pw") {
		t.Fatal("secret in backup.json")
	}
}
