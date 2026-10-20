package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func backupConfigPath() string {
	return envOr("HSI_BACKUP_CONFIG", "/etc/hsi/backup.json")
}

func backupSecretsDir() string {
	return envOr("HSI_BACKUP_SECRETS", "/etc/hsi/backup")
}

func backupStateDir() string {
	return envOr("HSI_BACKUP_STATE", "/var/lib/hsi/backup")
}

type backupSchedule struct {
	Every   string `json:"every"` // manual|hourly|daily|weekly
	Minute  int    `json:"minute"`
	Hour    int    `json:"hour"`
	Weekday int    `json:"weekday"`
}

type checkSchedule struct {
	Every   string `json:"every"` // off|daily|weekly|monthly
	Hour    int    `json:"hour"`
	Weekday int    `json:"weekday"`
	Day     int    `json:"day"`
	Subset  string `json:"subset"`
}

type retentionPolicy struct {
	KeepLast    int `json:"keepLast"`
	KeepDaily   int `json:"keepDaily"`
	KeepWeekly  int `json:"keepWeekly"`
	KeepMonthly int `json:"keepMonthly"`
}

type syncOptions struct {
	Direction      string   `json:"direction"`
	Source         string   `json:"source"`
	Destination    string   `json:"destination"`
	RemoteHost     string   `json:"remoteHost"`
	RemoteUser     string   `json:"remoteUser"`
	RemotePort     int      `json:"remotePort"`
	SSHKeyPath     string   `json:"sshKeyPath"`
	DeleteExtra    bool     `json:"deleteExtra"`
	Compress       bool     `json:"compress"`
	BandwidthLimit int      `json:"bandwidthLimit"`
	Excludes       []string `json:"excludes"`
}

type versionsOptions struct {
	Sources    []string        `json:"sources"`
	Repository string          `json:"repository"`
	Excludes   []string        `json:"excludes"`
	StopApps   []string        `json:"stopApps"`
	Retention  retentionPolicy `json:"retention"`
}

type backupPlanCfg struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Type     string           `json:"type"` // sync|versions
	Enabled  bool             `json:"enabled"`
	Schedule backupSchedule   `json:"schedule"`
	Sync     *syncOptions     `json:"sync,omitempty"`
	Versions *versionsOptions `json:"versions,omitempty"`
}

type repositoryCfg struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Type     string        `json:"type"` // local|sftp|s3|rest
	Path     string        `json:"path"`
	Host     string        `json:"host"`
	User     string        `json:"user"`
	Port     int           `json:"port"`
	Endpoint string        `json:"endpoint"`
	Bucket   string        `json:"bucket"`
	URL      string        `json:"url"`
	Check    checkSchedule `json:"check"`
}

type backupConfig struct {
	Plans        []backupPlanCfg `json:"plans"`
	Repositories []repositoryCfg `json:"repositories"`
}

// repoSecrets never goes into backup.json, it lives in a 0600 file per repository.
type repoSecrets struct {
	Password        string `json:"password"`
	SSHKeyPath      string `json:"sshKeyPath"`
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	RestUser        string `json:"restUser"`
	RestPassword    string `json:"restPassword"`
}

var (
	backupIDPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	backupAppPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	backupEndpointPattern = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]{1,5})?$`)
	backupBucketPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{2,62}$`)
	backupSubsetPattern   = regexp.MustCompile(`^([1-9][0-9]?|100)%$`)
)

var weekdayNames = [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func loadBackupConfig() (backupConfig, bool, error) {
	var c backupConfig
	raw, err := os.ReadFile(backupConfigPath())
	if errors.Is(err, os.ErrNotExist) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return backupConfig{}, true, fmt.Errorf("invalid backup configuration: %w", err)
	}
	return c, true, nil
}

// writeBackupFile always applies mode, unlike writeFileAtomic which keeps an existing file mode.
func writeBackupFile(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func saveBackupConfig(c backupConfig) error {
	if c.Plans == nil {
		c.Plans = []backupPlanCfg{}
	}
	if c.Repositories == nil {
		c.Repositories = []repositoryCfg{}
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(backupConfigPath()), 0o755); err != nil {
		return err
	}
	return writeBackupFile(backupConfigPath(), append(raw, '\n'), 0o644)
}

func (c backupConfig) plan(id string) (backupPlanCfg, bool) {
	for _, p := range c.Plans {
		if p.ID == id {
			return p, true
		}
	}
	return backupPlanCfg{}, false
}

func (c backupConfig) repository(id string) (repositoryCfg, bool) {
	for _, r := range c.Repositories {
		if r.ID == id {
			return r, true
		}
	}
	return repositoryCfg{}, false
}

func validName(name string) bool {
	if len(name) < 1 || len(name) > 80 {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

var sshKeyPathPattern = regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`)

// validSSHKeyPath keeps a key path safe to splice into an ssh command line: plain
// characters only, no whitespace, no parent component and no component that could
// read as an option.
func validSSHKeyPath(p string) error {
	if !sshKeyPathPattern.MatchString(p) {
		return fmt.Errorf("invalid SSH key path")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." || strings.HasPrefix(part, "-") {
			return fmt.Errorf("invalid SSH key path")
		}
	}
	return nil
}

func inRange(v, lo, hi int) bool { return v >= lo && v <= hi }

func validExcludes(list []string) error {
	if len(list) > 50 {
		return fmt.Errorf("too many exclusion patterns")
	}
	for _, e := range list {
		if e == "" || strings.ContainsAny(e, "\x00\r\n") {
			return fmt.Errorf("invalid exclusion pattern")
		}
	}
	return nil
}

func (c backupConfig) validate() error {
	repoIDs := map[string]bool{}
	for _, r := range c.Repositories {
		if !backupIDPattern.MatchString(r.ID) {
			return fmt.Errorf("invalid repository id")
		}
		if repoIDs[r.ID] {
			return fmt.Errorf("duplicate repository id %s", r.ID)
		}
		repoIDs[r.ID] = true
		if err := validateRepository(r); err != nil {
			return fmt.Errorf("repository %s: %w", r.ID, err)
		}
	}
	planIDs := map[string]bool{}
	for _, p := range c.Plans {
		if !backupIDPattern.MatchString(p.ID) {
			return fmt.Errorf("invalid plan id")
		}
		if planIDs[p.ID] {
			return fmt.Errorf("duplicate plan id %s", p.ID)
		}
		planIDs[p.ID] = true
		if err := validatePlan(p, repoIDs); err != nil {
			return fmt.Errorf("plan %s: %w", p.ID, err)
		}
	}
	return nil
}

func validatePlan(p backupPlanCfg, repoIDs map[string]bool) error {
	if !validName(p.Name) {
		return fmt.Errorf("invalid name")
	}
	s := p.Schedule
	switch s.Every {
	case "manual", "hourly", "daily", "weekly":
	default:
		return fmt.Errorf("invalid schedule")
	}
	if !inRange(s.Minute, 0, 59) || !inRange(s.Hour, 0, 23) || !inRange(s.Weekday, 0, 6) {
		return fmt.Errorf("invalid schedule time")
	}
	switch p.Type {
	case "sync":
		if p.Sync == nil || p.Versions != nil {
			return fmt.Errorf("sync plan needs sync options only")
		}
		return validateSync(*p.Sync)
	case "versions":
		if p.Versions == nil || p.Sync != nil {
			return fmt.Errorf("versions plan needs versions options only")
		}
		return validateVersions(*p.Versions, repoIDs)
	}
	return fmt.Errorf("invalid plan type")
}

func validateSync(o syncOptions) error {
	source, err := cleanBackupPath(o.Source)
	if err != nil {
		return err
	}
	destination, err := cleanBackupPath(o.Destination)
	if err != nil {
		return err
	}
	if o.Direction != "push" && o.Direction != "pull" {
		return fmt.Errorf("invalid backup direction")
	}
	if o.RemoteHost != "" {
		if !backupHost.MatchString(o.RemoteHost) || !backupUser.MatchString(o.RemoteUser) {
			return fmt.Errorf("invalid remote endpoint")
		}
		if !inRange(o.RemotePort, 1, 65535) {
			return fmt.Errorf("invalid SSH port")
		}
		if err := validSSHKeyPath(o.SSHKeyPath); err != nil {
			return err
		}
	} else {
		if o.RemoteUser != "" || o.SSHKeyPath != "" {
			return fmt.Errorf("remote host, user and key go together")
		}
		if source == destination || strings.HasPrefix(source+"/", destination+"/") || strings.HasPrefix(destination+"/", source+"/") {
			return fmt.Errorf("source and destination overlap")
		}
	}
	if o.BandwidthLimit < 0 {
		return fmt.Errorf("invalid bandwidth limit")
	}
	return validExcludes(o.Excludes)
}

func validateVersions(o versionsOptions, repoIDs map[string]bool) error {
	if len(o.Sources) < 1 || len(o.Sources) > 20 {
		return fmt.Errorf("1 to 20 sources required")
	}
	for _, src := range o.Sources {
		if _, err := cleanBackupPath(src); err != nil {
			return err
		}
	}
	if !repoIDs[o.Repository] {
		return fmt.Errorf("unknown repository")
	}
	r := o.Retention
	keeps := []int{r.KeepLast, r.KeepDaily, r.KeepWeekly, r.KeepMonthly}
	hasKeep := false
	for _, k := range keeps {
		if !inRange(k, 0, 1000) {
			return fmt.Errorf("invalid retention")
		}
		if k > 0 {
			hasKeep = true
		}
	}
	if !hasKeep {
		return fmt.Errorf("at least one retention value is required")
	}
	if err := validExcludes(o.Excludes); err != nil {
		return err
	}
	for _, app := range o.StopApps {
		if !backupAppPattern.MatchString(app) {
			return fmt.Errorf("invalid app name")
		}
	}
	return nil
}

func validateRepository(r repositoryCfg) error {
	if !validName(r.Name) {
		return fmt.Errorf("invalid name")
	}
	switch r.Type {
	case "local":
		if _, err := cleanBackupPath(r.Path); err != nil {
			return err
		}
	case "sftp":
		if !backupHost.MatchString(r.Host) || !backupUser.MatchString(r.User) {
			return fmt.Errorf("invalid SFTP endpoint")
		}
		if !inRange(r.Port, 1, 65535) {
			return fmt.Errorf("invalid SSH port")
		}
		if _, err := cleanBackupPath(r.Path); err != nil {
			return err
		}
	case "s3":
		if !backupEndpointPattern.MatchString(r.Endpoint) || !backupBucketPattern.MatchString(r.Bucket) {
			return fmt.Errorf("invalid S3 endpoint or bucket")
		}
		if strings.HasPrefix(r.Path, "/") || strings.ContainsAny(r.Path, "\x00\r\n") {
			return fmt.Errorf("invalid S3 prefix")
		}
		for _, part := range strings.Split(r.Path, "/") {
			if part == ".." {
				return fmt.Errorf("invalid S3 prefix")
			}
		}
	case "rest":
		u, err := url.Parse(r.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			return fmt.Errorf("invalid REST server URL")
		}
	default:
		return fmt.Errorf("invalid repository type")
	}
	return validateCheck(r.Check)
}

func validateCheck(k checkSchedule) error {
	switch k.Every {
	case "off":
		if k.Subset != "" && !backupSubsetPattern.MatchString(k.Subset) {
			return fmt.Errorf("invalid check subset")
		}
	case "daily", "weekly", "monthly":
		if !backupSubsetPattern.MatchString(k.Subset) {
			return fmt.Errorf("invalid check subset")
		}
	default:
		return fmt.Errorf("invalid check schedule")
	}
	if !inRange(k.Hour, 0, 23) || !inRange(k.Weekday, 0, 6) || !inRange(k.Day, 0, 28) || (k.Every == "monthly" && k.Day < 1) {
		return fmt.Errorf("invalid check schedule time")
	}
	return nil
}

func onCalendar(s backupSchedule) string {
	switch s.Every {
	case "hourly":
		return fmt.Sprintf("*-*-* *:%02d:00", s.Minute)
	case "daily":
		return fmt.Sprintf("*-*-* %02d:%02d:00", s.Hour, s.Minute)
	case "weekly":
		return fmt.Sprintf("%s *-*-* %02d:%02d:00", weekdayNames[s.Weekday], s.Hour, s.Minute)
	}
	return ""
}

func checkOnCalendar(s checkSchedule) string {
	switch s.Every {
	case "daily":
		return fmt.Sprintf("*-*-* %02d:00:00", s.Hour)
	case "weekly":
		return fmt.Sprintf("%s *-*-* %02d:00:00", weekdayNames[s.Weekday], s.Hour)
	case "monthly":
		return fmt.Sprintf("*-*-%02d %02d:00:00", s.Day, s.Hour)
	}
	return ""
}

func repoSecretsPath(id string) (string, error) {
	if !backupIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid repository id")
	}
	return filepath.Join(backupSecretsDir(), id+".json"), nil
}

func readRepoSecrets(id string) (repoSecrets, error) {
	var s repoSecrets
	path, err := repoSecretsPath(id)
	if err != nil {
		return s, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(raw, &s)
}

func writeRepoSecrets(id string, s repoSecrets) error {
	path, err := repoSecretsPath(id)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(backupSecretsDir(), 0o700); err != nil {
		return err
	}
	return writeBackupFile(path, raw, 0o600)
}

func removeRepoSecrets(id string) error {
	path, err := repoSecretsPath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
