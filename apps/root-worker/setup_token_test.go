package main

import (
	"os"
	"path/filepath"
	"testing"
)

func stubSetupToken(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "hsi", "setup-token")
	t.Setenv("HSI_SETUP_TOKEN", p)
	return p
}

func TestWriteSetupTokenMode(t *testing.T) {
	p := stubSetupToken(t)
	tok, err := writeSetupToken()
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil || st.Mode().Perm() != 0o600 || len(tok) != 43 {
		t.Fatalf("token file: %v %v len=%d", st, err, len(tok))
	}
	again, _ := writeSetupToken()
	if again == tok {
		t.Fatal("a new token each time")
	}
}

func TestVerifySetupToken(t *testing.T) {
	stubSetupToken(t)
	tok, _ := writeSetupToken()
	if !verifySetupToken(tok) || verifySetupToken(tok+"x") || verifySetupToken("") {
		t.Fatal("only the exact token")
	}
}

func TestVerifyTokenEmptyFile(t *testing.T) {
	p := stubSetupToken(t)
	if verifySetupToken("anything") {
		t.Fatal("missing file")
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, []byte("\n"), 0o600)
	if verifySetupToken("") || verifySetupToken("\n") {
		t.Fatal("empty file opens nothing")
	}
}

func TestConsumeSetupToken(t *testing.T) {
	p := stubSetupToken(t)
	tok, _ := writeSetupToken()
	if err := consumeSetupToken(); err != nil {
		t.Fatal(err)
	}
	if fileExists(p) || verifySetupToken(tok) {
		t.Fatal("consumed")
	}
	if err := consumeSetupToken(); err != nil {
		t.Fatalf("idempotent: %v", err)
	}
}

func TestSetupLink(t *testing.T) {
	if got := setupLink("192.168.1.48", 9001, "abc"); got != "http://192.168.1.48:9001/setup#token=abc" {
		t.Fatal(got)
	}
	if got := setupLink("10.0.0.2", 80, "abc"); got != "http://10.0.0.2/setup#token=abc" {
		t.Fatal(got)
	}
}
