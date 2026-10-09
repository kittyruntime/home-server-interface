package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// stubBackupHost points every source at temp dirs and returns the staging
// subdirectory an export works in.
func stubBackupHost(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	staging := filepath.Join(root, "staging")
	t.Setenv("HSI_BACKUP_STAGING", staging)
	t.Setenv("HSI_STORAGE_DESCRIPTIONS", filepath.Join(root, "storage"))
	pc, pm, pu, pg := containersDir, maintenanceConfigPath, hostLookupUser, hostLookupGroup
	t.Cleanup(func() { containersDir, maintenanceConfigPath, hostLookupUser, hostLookupGroup = pc, pm, pu, pg })
	containersDir = filepath.Join(root, "containers")
	maintenanceConfigPath = filepath.Join(root, "maintenance.json")
	hostLookupUser = func(name string) (int, int, bool) {
		switch name {
		case "alice":
			return 1001, 1001, true
		case "bob":
			return 1002, 1002, true
		}
		return 0, 0, false
	}
	hostLookupGroup = func(name string) (int, bool) {
		if name == "hsi-share" {
			return 1500, true
		}
		return 0, false
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(containersDir, "kuma"), 0o755))
	must(os.WriteFile(filepath.Join(containersDir, "kuma", "compose.yaml"), []byte("services: {}\n"), 0o644))
	must(os.WriteFile(filepath.Join(containersDir, "kuma", ".env"), []byte("A=1\n"), 0o600))
	must(os.WriteFile(maintenanceConfigPath, []byte(`{"smartShort":"weekly"}`), 0o644))
	_, err := saveDescription(storageDescription{Version: 1, Mount: descMount{Point: "/srv/data"}})
	must(err)
	dir := filepath.Join(staging, "export-1")
	must(os.MkdirAll(dir, 0o700))
	must(os.WriteFile(filepath.Join(dir, "database.db"), []byte("SQLite format 3\x00..."), 0o600))
	must(os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(`{"HSI_SECRETS_KEY":"ab"}`), 0o600))
	return dir
}

func readTar(t *testing.T, path string) map[string][]byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := map[string][]byte{}
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		out[h.Name] = b
	}
	return out
}

func TestBuildBackupTarContents(t *testing.T) {
	dir := stubBackupHost(t)
	if err := buildBackupTar(dir, []string{"alice", "bob", "ghost"}, "1.65.0", time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	files := readTar(t, filepath.Join(dir, "backup.tar"))
	var names []string
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	want := "database.db manifest.json secrets.json system/accounts.json system/containers/kuma/.env system/containers/kuma/compose.yaml system/maintenance.json system/storage/srv-data.yaml"
	if strings.Join(names, " ") != want {
		t.Fatalf("entries: %v", names)
	}
	var m backupManifest
	if err := json.Unmarshal(files["manifest.json"], &m); err != nil {
		t.Fatal(err)
	}
	if m.Format != 2 || m.HSIVersion != "1.65.0" || m.CreatedAt != "2026-10-08T10:00:00Z" || len(m.Items) != len(files)-1 {
		t.Fatalf("manifest: %+v", m)
	}
	for _, it := range m.Items {
		sum := sha256.Sum256(files[it.Path])
		if it.Size != int64(len(files[it.Path])) || it.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("item %+v", it)
		}
	}
	var acc accountsFile
	_ = json.Unmarshal(files["system/accounts.json"], &acc)
	if len(acc.Users) != 2 || acc.Users[0] != (accountRec{Name: "alice", UID: 1001, GID: 1001}) || len(acc.Groups) != 1 || acc.Groups[0].GID != 1500 {
		t.Fatalf("accounts: %+v", acc)
	}
}

func TestBuildBackupSkipsUnsafeAppFiles(t *testing.T) {
	dir := stubBackupHost(t)
	app := filepath.Join(containersDir, "kuma")
	_ = os.Symlink("/etc/shadow", filepath.Join(app, "link"))
	big := make([]byte, 10<<20+1)
	_ = os.WriteFile(filepath.Join(app, "big.bin"), big, 0o644)
	deep := filepath.Join(app, "a", "b", "c", "d", "e")
	_ = os.MkdirAll(deep, 0o755)
	_ = os.WriteFile(filepath.Join(deep, "deep.txt"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(app, "a", "ok.txt"), []byte("x"), 0o644)
	// A directory that is not an app (no compose.yaml) is not an app.
	_ = os.MkdirAll(filepath.Join(containersDir, "notes"), 0o755)
	_ = os.WriteFile(filepath.Join(containersDir, "notes", "x.txt"), []byte("x"), 0o644)
	if err := buildBackupTar(dir, nil, "1.65.0", time.Now()); err != nil {
		t.Fatal(err)
	}
	files := readTar(t, filepath.Join(dir, "backup.tar"))
	for n := range files {
		if strings.Contains(n, "link") || strings.Contains(n, "big.bin") || strings.Contains(n, "deep.txt") || strings.Contains(n, "notes") {
			t.Fatalf("unsafe entry %s", n)
		}
	}
	if _, ok := files["system/containers/kuma/a/ok.txt"]; ok {
		t.Fatal("subfolders (app data) are left out")
	}
}

func TestBuildBackupDirMustBeStaging(t *testing.T) {
	stubBackupHost(t)
	if err := buildBackupTar(t.TempDir(), nil, "1.65.0", time.Now()); err == nil {
		t.Fatal("a directory outside the staging root is refused")
	}
}
