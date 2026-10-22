package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// releaseSigningPub is the PEM public key that signs SHA256SUMS. A copy lives in
// scripts/release-signing.pub and in the scripts/install.sh heredoc; a test keeps them equal.
//
//go:embed release-signing.pub
var releaseSigningPub []byte

const (
	releaseDownloadTimeout = 15 * time.Minute
	releaseDownloadMax     = 1 << 30
)

var releaseBaseURL = envOr("HSI_RELEASE_BASE_URL", "https://github.com/kittyruntime/home-server-interface/releases/download")

// releaseFiles holds the local paths of a downloaded release.
type releaseFiles struct{ Sums, Sig, Archive, Installer string }

func releasePublicKey() (ed25519.PublicKey, error) {
	block, _ := pem.Decode(releaseSigningPub)
	if block == nil {
		return nil, fmt.Errorf("release signing key is not PEM")
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("release signing key: %w", err)
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("release signing key is not ed25519")
	}
	return pub, nil
}

func archiveName(version string) string {
	return unitPrefix() + "-" + version + "-linux-amd64.tar.gz"
}

// verifyRelease checks the signature over Sums, then the sha256 of Archive and
// Installer against it. It never modifies files.
func verifyRelease(pub ed25519.PublicKey, f releaseFiles, version string) error {
	sums, err := os.ReadFile(f.Sums)
	if err != nil {
		return fmt.Errorf("read SHA256SUMS: %w", err)
	}
	sigText, err := os.ReadFile(f.Sig)
	if err != nil {
		return fmt.Errorf("read SHA256SUMS.sig: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigText)))
	if err != nil {
		return fmt.Errorf("SHA256SUMS.sig is not base64: %w", err)
	}
	if len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, sums, sig) {
		return fmt.Errorf("SHA256SUMS signature is invalid")
	}
	listed := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		hash, name, ok := strings.Cut(sc.Text(), "  ")
		if ok {
			listed[name] = strings.ToLower(hash)
		}
	}
	for name, path := range map[string]string{archiveName(version): f.Archive, "install.sh": f.Installer} {
		want, ok := listed[name]
		if !ok {
			return fmt.Errorf("%s is not listed in SHA256SUMS", name)
		}
		got, err := fileSHA256(path)
		if err != nil {
			return err
		}
		if got != want {
			return fmt.Errorf("%s does not match SHA256SUMS", name)
		}
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	fh, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer fh.Close()
	h := sha256.New()
	if _, err := io.Copy(h, fh); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// downloadRelease fetches SHA256SUMS, SHA256SUMS.sig, the archive and install.sh of
// version into dir.
var downloadRelease = func(version, dir string) (releaseFiles, error) {
	f := releaseFiles{
		Sums:      filepath.Join(dir, "SHA256SUMS"),
		Sig:       filepath.Join(dir, "SHA256SUMS.sig"),
		Archive:   filepath.Join(dir, archiveName(version)),
		Installer: filepath.Join(dir, "install.sh"),
	}
	client := &http.Client{Timeout: releaseDownloadTimeout}
	base := strings.TrimRight(releaseBaseURL, "/") + "/" + version + "/"
	for _, p := range []string{f.Sums, f.Sig, f.Archive, f.Installer} {
		if err := fetchReleaseFile(client, base+filepath.Base(p), p); err != nil {
			return releaseFiles{}, err
		}
	}
	return f, nil
}

func fetchReleaseFile(client *http.Client, url, dest string) error {
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", filepath.Base(dest), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", filepath.Base(dest), resp.StatusCode)
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, releaseDownloadMax+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("download %s: %w", filepath.Base(dest), err)
	}
	if n > releaseDownloadMax {
		return fmt.Errorf("download %s: larger than the size cap", filepath.Base(dest))
	}
	return nil
}
