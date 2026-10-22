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

// devPub returns the development public key and allows it as trusted for this test.
func devPub(t *testing.T) ed25519.PublicKey {
	t.Helper()
	t.Setenv("HSI_ALLOW_DEV_SIGNING_KEY", "1")
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
	if _, err := releasePublicKey(); err != nil {
		t.Fatal(err)
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
	useReleaseBase(t, srv.URL)

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

// useReleaseBase points the downloader at base (http allowed, as the test variable would).
func useReleaseBase(t *testing.T, base string) {
	t.Helper()
	t.Setenv("HSI_RELEASE_BASE_URL", base)
	prev := releaseBaseURL
	releaseBaseURL = base
	t.Cleanup(func() { releaseBaseURL = prev })
}

func TestVerifyReleaseRefusesDevKeyByDefault(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	pub := devSigningKey(t).Public().(ed25519.PublicKey)
	t.Setenv("HSI_ALLOW_DEV_SIGNING_KEY", "")
	err := verifyRelease(pub, f, "v1.2.3")
	if err == nil || !strings.Contains(err.Error(), "development key") {
		t.Fatalf("want a development key refusal, got %v", err)
	}
	t.Setenv("HSI_ALLOW_DEV_SIGNING_KEY", "1")
	if err := verifyRelease(pub, f, "v1.2.3"); err != nil {
		t.Fatal(err)
	}
}

func TestDevKeyFingerprintMatchesTestdata(t *testing.T) {
	pub := devSigningKey(t).Public().(ed25519.PublicKey)
	h := sha256.Sum256(pub)
	if hex.EncodeToString(h[:]) != devKeyFingerprint {
		t.Fatal("devKeyFingerprint does not match testdata/dev-signing.key")
	}
}

func TestReleaseVersionValidated(t *testing.T) {
	good := signedRelease(t, "v1.2.3", devSigningKey(t))
	for _, v := range []string{"../v1.2.3", "v1.2.3/../x", "v1.2.3?x=1", "1.2.3", "v1.2", "v1.2.3\n", ""} {
		if err := verifyRelease(devPub(t), good, v); err == nil {
			t.Errorf("verifyRelease accepted version %q", v)
		}
		if _, err := downloadRelease(v, t.TempDir()); err == nil {
			t.Errorf("downloadRelease accepted version %q", v)
		}
	}
}

func resign(t *testing.T, f releaseFiles, sums string) {
	t.Helper()
	mustWrite(t, f.Sums, []byte(sums))
	mustWrite(t, f.Sig, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(devSigningKey(t), []byte(sums)))))
}

func TestVerifyReleaseStrictSums(t *testing.T) {
	arch := sumLine([]byte("fake archive"), archiveName("v1.2.3"))
	inst := sumLine([]byte("#!/bin/bash\necho install\n"), "install.sh")
	cases := map[string]string{
		"duplicate name": arch + inst + inst,
		"crlf":           strings.ReplaceAll(arch+inst, "\n", "\r\n"),
		"malformed line": arch + inst + "garbage\n",
		"short hash":     arch + inst + "abcd  other\n",
		"path in name":   arch + inst + strings.Repeat("a", 64) + "  ../x\n",
		"blank line":     arch + "\n" + inst,
	}
	for name, sums := range cases {
		f := signedRelease(t, "v1.2.3", devSigningKey(t))
		resign(t, f, sums)
		if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestVerifyReleaseSizeCaps(t *testing.T) {
	f := signedRelease(t, "v1.2.3", devSigningKey(t))
	prev := sumsMaxBytes
	sumsMaxBytes = 10
	t.Cleanup(func() { sumsMaxBytes = prev })
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("oversized SHA256SUMS accepted")
	}
	sumsMaxBytes = prev
	prevSig := sigMaxBytes
	sigMaxBytes = 10
	t.Cleanup(func() { sigMaxBytes = prevSig })
	if err := verifyRelease(devPub(t), f, "v1.2.3"); err == nil {
		t.Fatal("oversized signature accepted")
	}
}

func TestDownloadReleaseSizeCap(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 100)))
	}))
	defer srv.Close()
	useReleaseBase(t, srv.URL)
	prev := sumsMaxBytes
	sumsMaxBytes = 50
	t.Cleanup(func() { sumsMaxBytes = prev })
	if _, err := downloadRelease("v1.2.3", t.TempDir()); err == nil {
		t.Fatal("oversized SHA256SUMS download accepted")
	}
}

func TestDownloadReleaseRequiresHTTPS(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	t.Setenv("HSI_RELEASE_BASE_URL", "")
	prev := releaseBaseURL
	releaseBaseURL = srv.URL
	t.Cleanup(func() { releaseBaseURL = prev })
	_, err := downloadRelease("v1.2.3", t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("want an https refusal, got %v", err)
	}
}

func TestDownloadReleaseRefusesHTTPRedirect(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("x")) }))
	defer plain.Close()
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+"/x", http.StatusFound)
	}))
	defer tls.Close()
	t.Setenv("HSI_RELEASE_BASE_URL", "")
	prev := releaseBaseURL
	releaseBaseURL = tls.URL
	t.Cleanup(func() { releaseBaseURL = prev })
	prevTransport := releaseTransport
	releaseTransport = tls.Client().Transport
	t.Cleanup(func() { releaseTransport = prevTransport })
	_, err := downloadRelease("v1.2.3", t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("want a redirect refusal, got %v", err)
	}
}

// The http allowance follows the base URL actually in use, not the variable alone.
func TestDownloadReleaseInsecureFollowsBaseURLInUse(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("x")) }))
	defer plain.Close()
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+"/x", http.StatusFound)
	}))
	defer tls.Close()
	t.Setenv("HSI_RELEASE_BASE_URL", plain.URL)
	prev := releaseBaseURL
	releaseBaseURL = tls.URL
	t.Cleanup(func() { releaseBaseURL = prev })
	prevTransport := releaseTransport
	releaseTransport = tls.Client().Transport
	t.Cleanup(func() { releaseTransport = prevTransport })
	_, err := downloadRelease("v1.2.3", t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("want a redirect refusal, got %v", err)
	}
}
