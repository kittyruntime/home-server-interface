package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func devSigningKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	raw, err := os.ReadFile("testdata/dev-signing.key")
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		t.Fatal("dev-signing.key is not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return k.(ed25519.PrivateKey)
}

func sumLine(data []byte, name string) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]) + "  " + name + "\n"
}

// signedRelease writes a fake release into a temp dir, signed with key.
func signedRelease(t *testing.T, version string, key ed25519.PrivateKey) releaseFiles {
	t.Helper()
	dir := t.TempDir()
	f := releaseFiles{
		Sums:      filepath.Join(dir, "SHA256SUMS"),
		Sig:       filepath.Join(dir, "SHA256SUMS.sig"),
		Archive:   filepath.Join(dir, archiveName(version)),
		Installer: filepath.Join(dir, "install.sh"),
	}
	archive, installer := []byte("fake archive"), []byte("#!/bin/bash\necho install\n")
	mustWrite(t, f.Archive, archive)
	mustWrite(t, f.Installer, installer)
	sums := []byte(sumLine(archive, archiveName(version)) + sumLine(installer, "install.sh"))
	mustWrite(t, f.Sums, sums)
	mustWrite(t, f.Sig, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, sums))+"\n"))
	return f
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func devPub(t *testing.T) ed25519.PublicKey {
	t.Helper()
	return devSigningKey(t).Public().(ed25519.PublicKey)
}

func TestVerifyReleaseAcceptsSigned(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyReleaseRefusesTamperedSums(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	mustWrite(t, f.Sums, append([]byte(sumLine([]byte("evil"), "extra")), mustRead(t, f.Sums)...))
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("tampered SHA256SUMS accepted")
	}
}

func TestVerifyReleaseRefusesTamperedArchive(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	mustWrite(t, f.Archive, []byte("tampered"))
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("tampered archive accepted")
	}
}

func TestVerifyReleaseRefusesTamperedInstaller(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	mustWrite(t, f.Installer, []byte("#!/bin/bash\nrm -rf /\n"))
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("tampered installer accepted")
	}
}

func TestVerifyReleaseRefusesOtherKey(t *testing.T) {
	_, other, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := signedRelease(t, "v1.2.3", other)
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("signature from another key accepted")
	}
}

func TestVerifyReleaseRefusesMissingSig(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	_ = os.Remove(f.Sig)
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("missing signature accepted")
	}
}

func TestVerifyReleaseRefusesUnlistedArchive(t *testing.T) {
	key := devSigningKey(t)
	f := signedRelease(t, "v1.2.3", key)
	sums := []byte(sumLine(mustRead(t, f.Installer), "install.sh"))
	mustWrite(t, f.Sums, sums)
	mustWrite(t, f.Sig, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, sums))))
	err := verifyRelease(devPub(t), f, "v1.2.3")
	if err == nil || !strings.Contains(err.Error(), archiveName("v1.2.3")) {
		t.Fatalf("want an error naming the unlisted archive, got %v", err)
	}
}

func TestVerifyReleaseRefusesBadBase64(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	mustWrite(t, f.Sig, []byte("not base64 !!!"))
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("bad base64 signature accepted")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestEmbeddedKeyMatchesScriptsCopy(t *testing.T) {
	scripts := mustRead(t, "../../scripts/release-signing.pub")
	if string(releaseSigningPub) != string(scripts) {
		t.Fatal("embedded release-signing.pub differs from scripts/release-signing.pub")
	}
	pub, err := releasePublicKey()
	if err != nil {
		t.Fatal(err)
	}
	if !pub.Equal(devPub(t)) {
		t.Fatal("embedded key is not the development key")
	}
}

func TestArchiveName(t *testing.T) {
	if got := archiveName("v1.66.0"); got != "hsi-v1.66.0-linux-amd64.tar.gz" {
		t.Fatal(got)
	}
	t.Setenv("HSI_UNIT_PREFIX", "test")
	if got := archiveName("v2.0.0"); got != "test-v2.0.0-linux-amd64.tar.gz" {
		t.Fatal(got)
	}
}

func TestDownloadReleaseFetchesFourFiles(t *testing.T) {
	src := signedRelease(t, "v1.2.3", devSigningKey(t))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/v1.2.3/")
		for _, p := range []string{src.Sums, src.Sig, src.Archive, src.Installer} {
			if filepath.Base(p) == name {
				_, _ = w.Write(mustRead(t, p))
				return
			}
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	prev := releaseBaseURL
	releaseBaseURL = srv.URL
	defer func() { releaseBaseURL = prev }()

	f, err := downloadRelease("v1.2.3", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err != nil {
		t.Fatal(err)
	}
	if _, err := downloadRelease("v9.9.9", t.TempDir()); err == nil {
		t.Fatal("a 404 must fail the download")
	}
}
