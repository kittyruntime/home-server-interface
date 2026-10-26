package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestComposeTargetsJoinSnapshotAndRestore(t *testing.T) {
	e := setupUpdateEnv(t)
	containers := filepath.Join(e.install, "containers")
	t.Setenv("HSI_CONTAINERS_DIR", containers)
	mustWrite(t, e.db, []byte("database"))
	existing := filepath.Join(containers, "existing", "compose.yaml")
	if err := os.MkdirAll(filepath.Dir(existing), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, existing, []byte("old compose"))
	dir, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("old compose"))
	manifest := filepath.Join(t.TempDir(), "manifest.json")
	body := fmt.Sprintf(`{"entries":[{"name":"existing","operation":"replace","originalSha256":%q,"stagedSha256":%q},{"name":"new","operation":"create","originalSha256":null,"stagedSha256":%q}]}`, hex.EncodeToString(sum[:]), hex.EncodeToString(sum[:]), hex.EncodeToString(sum[:]))
	mustWrite(t, manifest, []byte(body))
	if err := addComposeSnapshot(dir, manifest); err != nil {
		t.Fatal(err)
	}
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 2 {
		t.Fatalf("snapshot files: %v", m.Files)
	}
	newFile := filepath.Join(containers, "new", "compose.yaml")
	if err := os.MkdirAll(filepath.Dir(newFile), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, existing, []byte("changed"))
	mustWrite(t, newFile, []byte("new compose"))
	if err := restoreFiles(dir, m); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(existing)
	if err != nil || string(b) != "old compose" {
		t.Fatalf("existing Compose not restored: %q, %v", b, err)
	}
	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Fatalf("new Compose not removed: %v", err)
	}
}

func TestComposeSnapshotRejectsChangedTarget(t *testing.T) {
	e := setupUpdateEnv(t)
	containers := filepath.Join(e.install, "containers")
	t.Setenv("HSI_CONTAINERS_DIR", containers)
	mustWrite(t, e.db, []byte("database"))
	p := filepath.Join(containers, "app", "compose.yaml")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, p, []byte("changed"))
	dir, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "manifest.json")
	mustWrite(t, manifest, []byte(`{"entries":[{"name":"app","operation":"replace","originalSha256":"0000000000000000000000000000000000000000000000000000000000000000","stagedSha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}`))
	if err := addComposeSnapshot(dir, manifest); err == nil {
		t.Fatal("accepted changed target")
	}
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 0 {
		t.Fatalf("partial manifest: %v", m.Files)
	}
}
